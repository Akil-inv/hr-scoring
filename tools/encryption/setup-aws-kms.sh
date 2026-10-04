#!/usr/bin/env bash
# One-time AWS setup for HR Scoring field encryption. Run it in AWS CloudShell
# (or anywhere with admin AWS credentials). Safe to run again: it updates
# what exists and creates what is missing.
#
#   ./setup-aws-kms.sh --instance-id i-0abc... --alert-email you@company.com
#
# Options:
#   --instance-id ID     the EC2 instance running HR Scoring (required)
#   --alert-email EMAIL  who is emailed if anyone disables, deletes or changes the key
#   --region REGION      default ap-southeast-1
#   --alias NAME         default alias/hr-scoring
#   --dry-run            print what would be done, change nothing
#
# What it does:
#   1. Creates the KMS key (or reuses the one with the alias), with yearly
#      automatic rotation, and a key policy under which only the account's
#      root user can disable the key or schedule it for deletion.
#   2. Lets the instance's IAM role use the key (and nothing else).
#   3. Lets containers on the instance reach the instance's credentials
#      (instance metadata hop limit 2).
#   4. Emails an alert on any attempt to disable, delete or re-permission a
#      KMS key in this account (turns CloudTrail on if it is not).
set -euo pipefail

REGION=ap-southeast-1
ALIAS=alias/hr-scoring
INSTANCE=""
EMAIL=""
DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --instance-id) INSTANCE="$2"; shift 2 ;;
    --alert-email) EMAIL="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --alias) ALIAS="$2"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,23p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1 (see --help)"; exit 1 ;;
  esac
done
[ -n "$INSTANCE" ] || { echo "Give the EC2 instance: --instance-id i-... (see --help)"; exit 1; }
case "$ALIAS" in alias/*) ;; *) ALIAS="alias/$ALIAS" ;; esac

# Reads always run; changes are only printed in a dry run.
read_aws() { aws --region "$REGION" "$@"; }
change() {
  if [ "$DRY" = 1 ]; then echo "  [dry run] aws $*" >&2; echo "DRY-RUN"; else aws --region "$REGION" "$@"; fi
}
say() { echo; echo "── $* ──"; }
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

ACCOUNT=$(read_aws sts get-caller-identity --query Account --output text)
PARTITION=$(read_aws sts get-caller-identity --query Arn --output text | cut -d: -f2)
ROOT="arn:${PARTITION}:iam::${ACCOUNT}:root"
echo "Account $ACCOUNT, region $REGION, key $ALIAS, instance $INSTANCE$([ "$DRY" = 1 ] && echo ' (dry run)')"

# ── 1. The key ───────────────────────────────────────────────────────────────
say "1/4 KMS key"
cat > "$TMP/key-policy.json" <<JSON
{
  "Version": "2012-10-17",
  "Id": "hr-scoring-field-encryption",
  "Statement": [
    {
      "Sid": "AccountAdministersTheKeyThroughIAM",
      "Effect": "Allow",
      "Principal": { "AWS": "$ROOT" },
      "Action": "kms:*",
      "Resource": "*"
    },
    {
      "Sid": "OnlyTheRootUserCanDisableOrDeleteTheKey",
      "Effect": "Deny",
      "Principal": { "AWS": "*" },
      "Action": ["kms:ScheduleKeyDeletion", "kms:DisableKey"],
      "Resource": "*",
      "Condition": { "ArnNotEquals": { "aws:PrincipalArn": "$ROOT" } }
    }
  ]
}
JSON
KEY_ID=$(read_aws kms describe-key --key-id "$ALIAS" --query KeyMetadata.KeyId --output text 2>/dev/null || true)
if [ -z "$KEY_ID" ] || [ "$KEY_ID" = "None" ]; then
  KEY_ID=$(change kms create-key --description "HR Scoring field encryption. Do not delete: data cannot be read without it." \
    --policy "file://$TMP/key-policy.json" --tags TagKey=app,TagValue=hr-scoring --query KeyMetadata.KeyId --output text)
  change kms create-alias --alias-name "$ALIAS" --target-key-id "$KEY_ID" >/dev/null
  echo "Created key $KEY_ID as $ALIAS."
else
  change kms put-key-policy --key-id "$KEY_ID" --policy-name default --policy "file://$TMP/key-policy.json" >/dev/null
  echo "Using existing key $KEY_ID ($ALIAS); policy updated."
fi
change kms enable-key-rotation --key-id "$KEY_ID" >/dev/null
KEY_ARN="arn:${PARTITION}:kms:${REGION}:${ACCOUNT}:key/${KEY_ID}"
echo "Automatic yearly rotation on. Only the root user can disable or delete the key."

# ── 2. The instance role ─────────────────────────────────────────────────────
say "2/4 Permission for the server"
PROFILE_ARN=$(read_aws ec2 describe-instances --instance-ids "$INSTANCE" \
  --query 'Reservations[0].Instances[0].IamInstanceProfile.Arn' --output text)
if [ -z "$PROFILE_ARN" ] || [ "$PROFILE_ARN" = "None" ]; then
  echo "The instance has no IAM role. Attach one (EC2 console > instance > Actions > Security > Modify IAM role), then run this again."
  exit 1
fi
ROLE=$(read_aws iam get-instance-profile --instance-profile-name "${PROFILE_ARN##*/}" --query 'InstanceProfile.Roles[0].RoleName' --output text)
cat > "$TMP/role-policy.json" <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "HrScoringFieldEncryption",
      "Effect": "Allow",
      "Action": ["kms:GenerateDataKey", "kms:Decrypt", "kms:Encrypt", "kms:DescribeKey"],
      "Resource": "$KEY_ARN"
    }
  ]
}
JSON
change iam put-role-policy --role-name "$ROLE" --policy-name hr-scoring-field-encryption \
  --policy-document "file://$TMP/role-policy.json" >/dev/null
echo "Role $ROLE may use this key, and only this key."

# ── 3. Instance metadata hop limit ───────────────────────────────────────────
say "3/4 Credentials inside containers"
change ec2 modify-instance-metadata-options --instance-id "$INSTANCE" \
  --http-endpoint enabled --http-put-response-hop-limit 2 >/dev/null
echo "Hop limit 2: the app's container can use the instance role."

# ── 4. Alerts ────────────────────────────────────────────────────────────────
say "4/4 Alerts"
if [ -z "$EMAIL" ]; then
  echo "Skipped (no --alert-email). Strongly recommended: run again with --alert-email."
else
  TRAILS=$(read_aws cloudtrail describe-trails --query 'length(trailList)' --output text)
  if [ "$TRAILS" = "0" ]; then
    BUCKET="hr-scoring-cloudtrail-${ACCOUNT}-${REGION}"
    cat > "$TMP/bucket-policy.json" <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    { "Sid": "CloudTrailAclCheck", "Effect": "Allow", "Principal": { "Service": "cloudtrail.amazonaws.com" },
      "Action": "s3:GetBucketAcl", "Resource": "arn:${PARTITION}:s3:::${BUCKET}" },
    { "Sid": "CloudTrailWrite", "Effect": "Allow", "Principal": { "Service": "cloudtrail.amazonaws.com" },
      "Action": "s3:PutObject", "Resource": "arn:${PARTITION}:s3:::${BUCKET}/AWSLogs/${ACCOUNT}/*",
      "Condition": { "StringEquals": { "s3:x-amz-acl": "bucket-owner-full-control" } } }
  ]
}
JSON
    if [ "$REGION" = "us-east-1" ]; then
      change s3api create-bucket --bucket "$BUCKET" >/dev/null
    else
      change s3api create-bucket --bucket "$BUCKET" --create-bucket-configuration "LocationConstraint=$REGION" >/dev/null
    fi
    change s3api put-public-access-block --bucket "$BUCKET" \
      --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true >/dev/null
    change s3api put-bucket-policy --bucket "$BUCKET" --policy "file://$TMP/bucket-policy.json" >/dev/null
    change cloudtrail create-trail --name hr-scoring-trail --s3-bucket-name "$BUCKET" --is-multi-region-trail >/dev/null
    change cloudtrail start-logging --name hr-scoring-trail >/dev/null
    echo "CloudTrail was off; turned on (trail hr-scoring-trail, logs in s3://$BUCKET)."
  fi

  TOPIC=$(change sns create-topic --name hr-scoring-key-alerts --query TopicArn --output text)
  cat > "$TMP/topic-policy.json" <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    { "Sid": "EventBridgePublishes", "Effect": "Allow", "Principal": { "Service": "events.amazonaws.com" },
      "Action": "sns:Publish", "Resource": "$TOPIC" },
    { "Sid": "AccountManages", "Effect": "Allow", "Principal": { "AWS": "$ROOT" },
      "Action": ["sns:Publish", "sns:Subscribe", "sns:SetTopicAttributes", "sns:GetTopicAttributes", "sns:ListSubscriptionsByTopic", "sns:DeleteTopic"],
      "Resource": "$TOPIC" }
  ]
}
JSON
  change sns set-topic-attributes --topic-arn "$TOPIC" --attribute-name Policy --attribute-value "file://$TMP/topic-policy.json" >/dev/null
  SUBSCRIBED=$(read_aws sns list-subscriptions-by-topic --topic-arn "$TOPIC" \
    --query "length(Subscriptions[?Endpoint=='$EMAIL'])" --output text 2>/dev/null || echo 0)
  if [ "$SUBSCRIBED" = "0" ]; then
    change sns subscribe --topic-arn "$TOPIC" --protocol email --notification-endpoint "$EMAIL" >/dev/null
  fi

  cat > "$TMP/pattern.json" <<'JSON'
{
  "source": ["aws.kms"],
  "detail-type": ["AWS API Call via CloudTrail"],
  "detail": {
    "eventSource": ["kms.amazonaws.com"],
    "eventName": ["DisableKey", "ScheduleKeyDeletion", "PutKeyPolicy", "DeleteAlias", "UpdateAlias", "DisableKeyRotation"]
  }
}
JSON
  change events put-rule --name hr-scoring-key-alerts --event-pattern "file://$TMP/pattern.json" \
    --description "HR Scoring: someone changed a KMS key" >/dev/null
  cat > "$TMP/targets.json" <<JSON
[
  {
    "Id": "email",
    "Arn": "$TOPIC",
    "InputTransformer": {
      "InputPathsMap": { "action": "$.detail.eventName", "who": "$.detail.userIdentity.arn", "key": "$.detail.requestParameters.keyId", "when": "$.time", "error": "$.detail.errorCode" },
      "InputTemplate": "\"HR Scoring key alert: <action> on KMS key <key> by <who> at <when> (error if refused: <error>). If this was not planned: KMS console > Customer managed keys > the key > Key actions > Cancel key deletion / Enable. The app's data cannot be read without this key.\""
    }
  }
]
JSON
  change events put-targets --rule hr-scoring-key-alerts --targets "file://$TMP/targets.json" >/dev/null
  echo "Alerts go to $EMAIL. CONFIRM the subscription from the email AWS just sent."
fi

say "Done"
cat <<EOF
On the server, in the hr-scoring folder:

  1. Back up the database first:
       docker-compose exec -T postgres pg_dump -U hackathon hackathon | gzip > ~/hr-before-encryption.sql.gz
  2. echo 'KMS_KEY_ID=$ALIAS' >> .env
  3. DEPLOY_BRANCH=feature/interview-availability ./deploy.sh
  4. ./encryption.sh status         (all values encrypted, key held by KMS)
  5. ./encryption.sh recovery-kit   print it, store it offline, delete nothing
  6. Once the app reads correctly: shred -u ~/hr-before-encryption.sql.gz
EOF
