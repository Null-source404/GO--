# SonicCrate Firestore Security Specification (Phase 0 TDD)

## 1. Data Invariants
1. **Default Deny**: All paths not explicitly matched in `/users/{userId}` and `/users/{userId}/private/{docId}` are unconditionally denied (`allow read, write: if false`).
2. **Identity Integrity**: A user document at `/users/{userId}` can only be read, created, or updated by the authenticated user whose `request.auth.uid == userId` and `incoming().ownerId == request.auth.uid`.
3. **Verified Email Requirement**: Standard write operations require `request.auth.token.email_verified == true`.
4. **PII Isolation (Split Collection)**: User email addresses are stored exclusively in `/users/{userId}/private/{docId}`, never in `/users/{userId}`, and can only be read or created when the parent `/users/{userId}` exists (or is created in the same batch via `existsAfter`) and `request.auth.uid == userId`.
5. **Strict Schema & Key Whitelisting**: No undocumented or shadow fields (`isAdmin`, `role`, `isVerified`) may be injected on create or update.
6. **Temporal & Immutable Fields**: `ownerId` and `createdAt` are immutable after creation; `createdAt` and `updatedAt` must equal `request.time`.

## 2. The "Dirty Dozen" Payloads
1. **Unauthenticated Create**: Creating `/users/user_1` with `auth == null`.
2. **UID Spoofing**: Authenticated as `user_2`, creating `/users/user_1` or setting `ownerId: "user_1"`.
3. **Unverified Email Write**: Authenticated with `email_verified: false` attempting to create `/users/user_1`.
4. **Shadow Field Injection on Create**: Creating `/users/user_1` with an extra field `role: "admin"`.
5. **Shadow Field Injection on Update**: Updating `/users/user_1` with `isSuperUser: true`.
6. **Immutable `ownerId` Mutation**: Updating `/users/user_1` to change `ownerId` to `"user_2"`.
7. **Immutable `createdAt` Mutation**: Updating `/users/user_1` with a modified `createdAt` timestamp.
8. **Forged Client Timestamp**: Creating `/users/user_1` where `createdAt` does not match `request.time`.
9. **Oversized `displayName` Resource Poisoning**: Creating `/users/user_1` with a 5,000-character `displayName` (`maxLength: 80`).
10. **Invalid Path ID Poisoning**: Creating a document with a malformed or oversized `{userId}` containing invalid characters.
11. **Cross-User PII Read**: Authenticated as `user_2`, attempting `get` on `/users/user_1/private/info`.
12. **Orphaned Private Subcollection Write**: Creating `/users/user_1/private/info` when parent `/users/user_1` does not exist.
