// Edit this list as election modules are added. Keep the "module:action" shape.
export const PERMISSIONS = [
  'company:read',
  'company:update',
  'users:read',
  'users:manage',
  'voters:read',
  'voters:write',
  'campaigns:read',
  'campaigns:write',
  'reports:read',
];

export const ROLES = { SUPER_ADMIN: 'SUPER_ADMIN', OWNER: 'OWNER', ADMIN: 'ADMIN', MANAGER: 'MANAGER', STAFF: 'STAFF', VIEWER: 'VIEWER' };

// Roles an Owner can hand out to company users. OWNER is never assignable.
export const ASSIGNABLE_ROLES = ['ADMIN', 'MANAGER', 'STAFF', 'VIEWER'];

const ROLE_DEFAULTS = {
  OWNER: PERMISSIONS,
  ADMIN: PERMISSIONS.filter((p) => p !== 'company:update'),
  MANAGER: ['company:read', 'users:read', 'voters:read', 'voters:write', 'campaigns:read', 'campaigns:write', 'reports:read'],
  STAFF: ['company:read', 'voters:read', 'voters:write', 'campaigns:read'],
  VIEWER: ['company:read', 'voters:read', 'campaigns:read', 'reports:read'],
};

// Owner always has everything. For others: explicit override if set, else role defaults.
export function effectivePermissions(user) {
  if (user.role === 'OWNER') return PERMISSIONS;
  return Array.isArray(user.permissions) ? user.permissions : ROLE_DEFAULTS[user.role] ?? [];
}
