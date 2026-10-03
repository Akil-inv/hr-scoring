# Backend blockers — found in generated schema.gql

Both of these are evidenced by the generated schema, not guesswork. Fix them
before the user management page will do anything.

---

## Blocker 1 — UsersModule is not registered

`users.resolver.ts` exists and compiles, but none of its fields are in the graph.

Search `schema.gql` for any of these — all absent:

```
createUser  users  assignEventRole  removeEventRole
deleteUser  resetUserPassword  myEvents  UserEntity  MyEvent
```

`type Mutation` (line 332) ends at `updateTrack`. `type Query` (line 396) has no
`users` and no `myEvents`. NestJS code-first only emits resolvers reachable from
`AppModule`, so `UsersModule` was never added to the imports array.

### Fix

In `apps/api/src/app.module.ts`:

```typescript
import { UsersModule } from './users/users.module';

@Module({
  imports: [
    // ...existing modules
    UsersModule,
  ],
})
export class AppModule {}
```

### Verify

```bash
cd ~/hackathon-platform/apps/api
rm -rf dist && npx nest build
grep -c "createUser\|myEvents" src/schema.gql   # expect 2+
```

If the grep still returns 0, check that `UsersModule` actually declares
`UsersResolver` in its `providers` array.

---

## Blocker 2 — `SUPER_ADMIN` is missing from the GraphQL `Role` enum

`schema.gql` line 483:

```graphql
enum Role {
  ADMIN
  AUDITOR
  COORDINATOR
  JUDGE
  PANEL_CHAIR
  TEAM_REP
}
```

No `SUPER_ADMIN`. But the handover says `admin@hackathon.local` was updated to
`SUPER_ADMIN` in the database via direct SQL.

`me: UserResponse!` and `login.user.role` both return `Role!`. GraphQL validates
enums on the way out, so as soon as the resolver returns the string
`SUPER_ADMIN` for a value not in the enum, the field throws:

```
Enum "Role" cannot represent value: "SUPER_ADMIN"
```

That breaks login and `me` for the admin account. One of two things is true:

- **The enum was never regenerated.** Prisma schema has `SUPER_ADMIN`, but
  `npx prisma generate` wasn't re-run on the Mac before this build, so the TS
  enum passed to `registerEnumType` is stale. Production may be broken right now.
- **`schema.gql` is stale.** It predates the change and EC2 is fine.

### How to tell which

```bash
# On EC2 — does the DB actually hold SUPER_ADMIN?
docker-compose exec -T postgres psql -U hackathon hackathon \
  -c "select email, role from users;"

# Then just log in as admin@hackathon.local and watch the API logs
docker-compose logs -f api
```

### Fix

```bash
cd ~/hackathon-platform/apps/api
npx prisma generate       # regenerate the Role enum from schema.prisma
rm -rf dist && npx nest build
grep -A8 "^enum Role" src/schema.gql   # SUPER_ADMIN should now be listed
```

If `Role` is hand-declared in TypeScript rather than imported from
`@prisma/client`, add the member manually and keep it in sync with
`schema.prisma`.

### Also check the auth guard

`@Roles('SUPER_ADMIN', 'ADMIN')` on the users resolver compares against the
JWT's role claim. If tokens were issued before the DB change, the claim still
says `ADMIN`. Sign out and back in after fixing, or the users page will 403.

---

## Not a blocker, but noted for P1

`phone` exists on `JudgeEntity` (line 271) but **not** on `CreateJudgeInput`
(line 104) or `UpdateJudgeInput` (line 820). So phone can be read and imported
from CSV, but not edited through the API.

For "phone editable on Judge Links page", add to `UpdateJudgeInput`:

```typescript
@Field({ nullable: true }) phone?: string;
```

and make sure `updateJudge` in `judges.service.ts` passes it through.
