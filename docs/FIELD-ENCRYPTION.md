# Field encryption (AWS KMS)

Candidate data is stored encrypted in Postgres and decrypted by the API only
when a screen, export or PDF needs it. A copy of the database, a backup or a
disk snapshot on its own shows only `enc:v1:…` / `det:v1:…` text and
encrypted PDF bytes.

## What is encrypted

| Table | Fields |
|---|---|
| Candidates (`teams`) | name*, project name, lead name and email, statements, notes |
| `team_members` | name, email |
| Judges | name, email*, phone, organisation, designation |
| Scorecards | strengths, improvements, recommendation, reopen reason, **total score**, **support Yes/No** |
| Criterion scores | **score**, comment |
| HR decisions | comments, reopen reason |
| PDF reports | the PDF itself, file name, superseded reason |
| Audit log | old / new values, reason |
| Judge messages, conflicts, session notes | the text |

\* Encrypted deterministically, so exact lookups (a candidate by name in an
event, a judge by email) still work. Everything else uses a fresh random IV
and can't be searched in the database. Emails are stored in lower case.

Not encrypted: user accounts (HR admins log in by email), event, room,
schedule and rubric set-up, the decision outcome (Selected / Waitlist / …),
and dates.

## How it works

- **Envelope encryption.** On first start the API asks KMS for a 256-bit
  data key (`GenerateDataKey`). Only the KMS-wrapped copy is stored, in
  `data_keys`. On every start the API asks KMS to unwrap it (`Decrypt`) and
  holds it in memory. Every unwrap is logged in CloudTrail.
- **AES-256-GCM** per value, tamper-evident. Each value carries its key
  version, so a new data key can be added later without re-encrypting.
- A Prisma middleware (`apps/api/src/crypto/`) encrypts on write and
  decrypts on read. Services are unchanged.
- Numbers and Yes/No can't be held encrypted in number columns, so `score`,
  `total_score` and `support` each have a `*_enc` text column. The number
  column is left empty.
- **Existing data** is encrypted automatically on the first start with the
  key (it takes seconds). Re-runs skip what is already encrypted.
- **Safety:** if `data_keys` has a key but `KMS_KEY_ID` is missing, the API
  refuses to start rather than run half-encrypted. If KMS can't be reached
  or the role lacks permission, it also refuses to start, and the log says
  why.

## One-time setup (ap-southeast-1)

Run these from a shell with admin AWS credentials (CloudShell is fine).

1. **Create the key and an alias**
   ```bash
   KEY_ID=$(aws kms create-key --region ap-southeast-1 \
     --description "hr-scoring field encryption" --query KeyMetadata.KeyId --output text)
   aws kms create-alias --region ap-southeast-1 --alias-name alias/hr-scoring --target-key-id $KEY_ID
   aws kms enable-key-rotation --region ap-southeast-1 --key-id $KEY_ID
   aws kms describe-key --region ap-southeast-1 --key-id $KEY_ID --query KeyMetadata.Arn --output text
   ```

2. **Let the EC2 instance role use it.** Find the role on the instance
   (`IamInstanceProfile` in `aws ec2 describe-instances`) and attach this
   inline policy, using the key ARN from step 1:
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [{
       "Effect": "Allow",
       "Action": ["kms:GenerateDataKey", "kms:Decrypt"],
       "Resource": "arn:aws:kms:ap-southeast-1:<account>:key/<key-id>"
     }]
   }
   ```

3. **Let containers reach the instance credentials.** With IMDSv2, a
   container is one network hop further away:
   ```bash
   aws ec2 modify-instance-metadata-options --region ap-southeast-1 \
     --instance-id <i-…> --http-endpoint enabled --http-put-response-hop-limit 2
   ```

4. **Back up, then turn it on.** On the server, in the hr-scoring folder:
   ```bash
   docker-compose -p hr-scoring exec -T postgres pg_dump -U hackathon hackathon | gzip > /root/hr-before-encryption.sql.gz
   echo 'KMS_KEY_ID=alias/hr-scoring' >> .env
   DEPLOY_BRANCH=feature/interview-availability nohup ./deploy.sh > deploy.log 2>&1 &
   ```
   Then check:
   ```bash
   docker-compose -p hr-scoring logs api | grep -i encrypt
   #  Created the field-encryption data key with KMS (version 1).
   #  Field encryption on (AWS KMS, 1 data key).
   #  Encrypted N existing … rows.
   ```
   Once the app reads correctly, delete the plaintext backup
   (`shred -u /root/hr-before-encryption.sql.gz`).

## Rules from now on

- **Never delete or disable the KMS key**, and never delete `data_keys`
  rows. Without them the data cannot be read by anyone, including us.
  (KMS deletion has a 7–30 day waiting period; cancel it if it is ever
  scheduled by mistake.)
- Backups must include `data_keys`. A backup is only readable together with
  the KMS key, which is the point.
- Restoring to another AWS account needs the key policy to allow that
  account to `Decrypt`.

## Local and test runs

`FIELD_ENCRYPTION_KEY` (base64 of 32 random bytes,
`openssl rand -base64 32`) uses a local key instead of KMS. It is for
development and tests only. With neither variable set, encryption is off
and `/health` shows `"encryption": "off"`.
