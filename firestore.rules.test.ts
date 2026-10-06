/**
 * Phase 0 Security TDD Test Suite for SonicCrate Firestore Rules
 * Verifies that all "Dirty Dozen" payloads return PERMISSION_DENIED.
 */

export interface TestPayload {
  name: string;
  path: string;
  operation: 'get' | 'create' | 'update' | 'delete';
  auth: { uid: string; email_verified: boolean } | null;
  data?: Record<string, unknown>;
  expected: 'PERMISSION_DENIED' | 'ALLOWED';
}

export const dirtyDozenTests: TestPayload[] = [
  {
    name: '01. Unauthenticated Create',
    path: '/users/user_1',
    operation: 'create',
    auth: null,
    data: { ownerId: 'user_1', displayName: 'Alex', emailVerified: true },
    expected: 'PERMISSION_DENIED',
  },
  {
    name: '02. UID Spoofing on Create',
    path: '/users/user_1',
    operation: 'create',
    auth: { uid: 'user_2', email_verified: true },
    data: { ownerId: 'user_1', displayName: 'Alex', emailVerified: true },
    expected: 'PERMISSION_DENIED',
  },
  {
    name: '03. Unverified Email Write',
    path: '/users/user_1',
    operation: 'create',
    auth: { uid: 'user_1', email_verified: false },
    data: { ownerId: 'user_1', displayName: 'Alex', emailVerified: false },
    expected: 'PERMISSION_DENIED',
  },
  {
    name: '04. Shadow Field Injection on Create (role: admin)',
    path: '/users/user_1',
    operation: 'create',
    auth: { uid: 'user_1', email_verified: true },
    data: { ownerId: 'user_1', displayName: 'Alex', emailVerified: true, role: 'admin' },
    expected: 'PERMISSION_DENIED',
  },
  {
    name: '05. Shadow Field Injection on Update',
    path: '/users/user_1',
    operation: 'update',
    auth: { uid: 'user_1', email_verified: true },
    data: { ownerId: 'user_1', displayName: 'Alex', emailVerified: true, isSuperUser: true },
    expected: 'PERMISSION_DENIED',
  },
  {
    name: '06. Immutable ownerId Mutation on Update',
    path: '/users/user_1',
    operation: 'update',
    auth: { uid: 'user_1', email_verified: true },
    data: { ownerId: 'user_2', displayName: 'Alex', emailVerified: true },
    expected: 'PERMISSION_DENIED',
  },
  {
    name: '07. Immutable createdAt Mutation on Update',
    path: '/users/user_1',
    operation: 'update',
    auth: { uid: 'user_1', email_verified: true },
    data: { ownerId: 'user_1', displayName: 'Alex', emailVerified: true, createdAt: '2020-01-01T00:00:00Z' },
    expected: 'PERMISSION_DENIED',
  },
  {
    name: '08. Forged Client Timestamp on Create',
    path: '/users/user_1',
    operation: 'create',
    auth: { uid: 'user_1', email_verified: true },
    data: { ownerId: 'user_1', displayName: 'Alex', emailVerified: true, createdAt: '1999-01-01T00:00:00Z' },
    expected: 'PERMISSION_DENIED',
  },
  {
    name: '09. Oversized displayName Resource Poisoning',
    path: '/users/user_1',
    operation: 'create',
    auth: { uid: 'user_1', email_verified: true },
    data: { ownerId: 'user_1', displayName: 'A'.repeat(5000), emailVerified: true },
    expected: 'PERMISSION_DENIED',
  },
  {
    name: '10. Invalid Path ID Poisoning',
    path: '/users/invalid$id!@#',
    operation: 'create',
    auth: { uid: 'invalid$id!@#', email_verified: true },
    data: { ownerId: 'invalid$id!@#', displayName: 'Alex', emailVerified: true },
    expected: 'PERMISSION_DENIED',
  },
  {
    name: '11. Cross-User PII Read on Private Subcollection',
    path: '/users/user_1/private/info',
    operation: 'get',
    auth: { uid: 'user_2', email_verified: true },
    expected: 'PERMISSION_DENIED',
  },
  {
    name: '12. Orphaned Private Subcollection Write without Parent',
    path: '/users/user_1/private/info',
    operation: 'create',
    auth: { uid: 'user_1', email_verified: true },
    data: { ownerId: 'user_1', email: 'alex@example.com' },
    expected: 'PERMISSION_DENIED',
  },
];
