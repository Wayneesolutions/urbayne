const B = 'http://localhost:4000/api';
let pass = 0, fail = 0;
const call = async (method, path, body, token) => {
  const r = await fetch(B + path, { method, headers: { 'content-type': 'application/json', ...(token && { authorization: 'Bearer ' + token }) }, body: body && JSON.stringify(body) });
  return { s: r.status, b: r.status === 204 ? null : await r.json() };
};
const t = (name, cond, extra) => { cond ? pass++ : fail++; console.log(cond ? 'ok  ' : 'FAIL', name, cond ? '' : JSON.stringify(extra)); };

let r = await call('POST', '/auth/super-admin/login', { email: 'super@test.com', password: 'wrong' }); t('SA wrong pw 401', r.s === 401, r);
r = await call('POST', '/auth/super-admin/login', { email: 'super@test.com', password: 'super-secret-pass-123' }); t('SA login', r.s === 200, r); const sa = r.b.token;
r = await call('GET', '/admin/owners'); t('admin no token 401', r.s === 401, r);

r = await call('POST', '/admin/owners', { name: 'Owner A', email: 'A@x.com' }, sa); t('SA creates owner + temp pw', r.s === 201 && r.b.credentials.temporaryPassword.length === 12, r);
const aId = r.b.owner.id, aTmp = r.b.credentials.temporaryPassword;
r = await call('POST', '/admin/owners', { name: 'Dup', email: 'a@x.com' }, sa); t('dup email 409', r.s === 409, r);
r = await call('POST', '/auth/register', { name: 'Evil', email: 'super@test.com', password: 'password1' }); t('cannot register SA email', r.s === 409, r);

r = await call('POST', '/auth/login', { email: 'a@x.com', password: aTmp }); t('owner A login', r.s === 200 && r.b.user.mustChangePassword, r); let a = r.b.token;
r = await call('POST', '/company', { name: 'A Co' }, a); t('blocked until pw change', r.s === 403 && r.b.error.code === 'PASSWORD_CHANGE_REQUIRED', r);
r = await call('POST', '/auth/change-password', { currentPassword: aTmp, newPassword: 'ownerA-pass1' }, a); t('change pw', r.s === 200, r); const aOld = a; a = r.b.token;
r = await call('GET', '/auth/me', null, aOld); t('old token dead after pw change', r.s === 401, r);
r = await call('GET', '/admin/owners', null, a); t('owner cannot hit admin', r.s === 403, r);
r = await call('GET', '/users', null, a); t('users before company 409', r.s === 409, r);
r = await call('POST', '/company', { name: 'A Co', country: 'Canada', website: 'https://a.co' }, a); t('create company', r.s === 201, r);
r = await call('POST', '/company', { name: 'A Co 2' }, a); t('second company 409', r.s === 409, r);
r = await call('PATCH', '/company', { city: 'Winnipeg' }, a); t('update company', r.s === 200 && r.b.company.city === 'Winnipeg' && r.b.company.name === 'A Co', r);

r = await call('POST', '/auth/register', { name: 'Owner B', email: 'b@x.com', password: 'ownerB-pass1' }); t('owner B self-register -> pending, no token', r.s === 201 && !r.b.token && r.b.status === 'PENDING_APPROVAL', r); const bId = r.b.user.id;
r = await call('POST', '/auth/login', { email: 'b@x.com', password: 'ownerB-pass1' }); t('pending owner cannot login', r.s === 403 && r.b.error.code === 'PENDING_APPROVAL', r);
r = await call('POST', '/auth/login', { email: 'b@x.com', password: 'wrong-pass' }); t('pending + wrong pw looks like any bad login', r.s === 401, r);
r = await call('GET', '/admin/owners?status=PENDING', null, sa); t('SA sees pending queue', r.b.owners.length === 1 && r.b.pendingCount === 1 && r.b.owners[0].id === bId, r);
r = await call('POST', '/admin/owners/' + bId + '/approve', null, a); t('owner cannot approve', r.s === 403, r);
r = await call('POST', '/admin/owners/' + bId + '/reject', { reason: 'Need more info' }, sa); t('SA rejects', r.s === 200 && r.b.owner.approvalStatus === 'REJECTED' && r.b.owner.rejectionReason === 'Need more info', r);
r = await call('POST', '/auth/login', { email: 'b@x.com', password: 'ownerB-pass1' }); t('rejected owner cannot login', r.s === 403 && r.b.error.code === 'REGISTRATION_REJECTED', r);
r = await call('POST', '/admin/owners/' + bId + '/reject', null, sa); t('reject twice 409', r.s === 409, r);
r = await call('POST', '/admin/owners/' + bId + '/approve', null, sa); t('SA approves (after reject)', r.s === 200 && r.b.owner.approvalStatus === 'APPROVED' && r.b.owner.approvedAt && r.b.owner.rejectionReason === null, r);
r = await call('POST', '/admin/owners/' + aId + '/reject', null, sa); t('cannot reject approved owner', r.s === 409, r);
r = await call('GET', '/admin/owners/' + aId, null, sa); t('SA-created owner is pre-approved', r.b.owner.approvalStatus === 'APPROVED', r);
r = await call('POST', '/auth/login', { email: 'b@x.com', password: 'ownerB-pass1' }); t('approved owner B logs in', r.s === 200, r); const b = r.b.token;
const [p1, p2] = await Promise.all([call('POST', '/company', { name: 'B1' }, b), call('POST', '/company', { name: 'B2' }, b)]);
t('parallel company create: exactly one wins', [p1.s, p2.s].sort().join() === '201,409', [p1, p2]);

r = await call('POST', '/users', { name: 'Admin A', email: 'admin@a.com', role: 'ADMIN' }, a); t('owner creates admin', r.s === 201, r); const adminId = r.b.user.id, adminTmp = r.b.credentials.temporaryPassword;
r = await call('POST', '/users', { name: 'Staff A', email: 'staff@a.com', role: 'STAFF' }, a); t('owner creates staff', r.s === 201, r); const staffId = r.b.user.id, staffTmp = r.b.credentials.temporaryPassword;
r = await call('POST', '/users', { name: 'X', email: 'o@a.com', role: 'OWNER' }, a); t('cannot create second OWNER', r.s === 400, r);
r = await call('POST', '/users', { name: 'B staff', email: 'staff@b.com', role: 'STAFF' }, b); const bStaffId = r.b.user.id;

// isolation
r = await call('GET', '/users', null, b); t('B sees only B users', r.s === 200 && r.b.users.length === 2 && r.b.users.every(u => u.email.endsWith('b.com') || u.email === 'b@x.com'), r);
r = await call('GET', '/users/' + staffId, null, b); t('B cannot read A user', r.s === 404, r);
r = await call('PATCH', '/users/' + staffId, { name: 'hacked' }, b); t('B cannot edit A user', r.s === 404, r);
r = await call('DELETE', '/users/' + staffId, null, b); t('B cannot delete A user', r.s === 404, r);
r = await call('POST', '/users/' + staffId + '/reset-password', null, b); t('B cannot reset A user pw', r.s === 404, r);
r = await call('GET', '/company', null, b); t('B gets own company', r.b.company.name.startsWith('B'), r);
r = await call('GET', '/company', null, sa); t('SA not a tenant user', r.s === 403, r);

// staff
r = await call('POST', '/auth/login', { email: 'staff@a.com', password: staffTmp }); let st = r.b.token;
r = await call('POST', '/auth/change-password', { currentPassword: staffTmp, newPassword: 'staff-pass-1' }, st); st = r.b.token;
r = await call('GET', '/users', null, st); t('staff cannot list users', r.s === 403, r);
r = await call('PATCH', '/company', { name: 'x y' }, st); t('staff cannot edit company', r.s === 403, r);
r = await call('POST', '/company', { name: 'x y' }, st); t('staff cannot create company', r.s === 403, r);
r = await call('GET', '/company', null, st); t('staff can read company', r.s === 200, r);

// admin
r = await call('POST', '/auth/login', { email: 'admin@a.com', password: adminTmp }); let ad = r.b.token;
r = await call('POST', '/auth/change-password', { currentPassword: adminTmp, newPassword: 'admin-pass-1' }, ad); ad = r.b.token;
r = await call('POST', '/users', { name: 'Viewer', email: 'v@a.com', role: 'VIEWER' }, ad); t('admin creates viewer', r.s === 201, r);
r = await call('POST', '/users', { name: 'Adm2', email: 'ad2@a.com', role: 'ADMIN' }, ad); t('admin cannot create admin', r.s === 403, r);
r = await call('PATCH', '/users/' + staffId, { role: 'ADMIN' }, ad); t('admin cannot promote to admin', r.s === 403, r);
r = await call('PATCH', '/users/' + staffId, { permissions: ['users:manage'] }, ad); t('admin cannot set custom perms', r.s === 403, r);
r = await call('PATCH', '/users/' + adminId, { role: 'MANAGER' }, ad); t('admin cannot edit self', r.s === 400, r);
r = await call('PATCH', '/users/' + aId, { isActive: false }, ad); t('admin cannot touch owner', r.s === 403, r);
r = await call('PATCH', '/company', { name: 'zz' }, ad); t('admin cannot edit company', r.s === 403, r);

// owner custom permissions take effect immediately
r = await call('PATCH', '/users/' + staffId, { permissions: ['users:read', 'bogus:perm'] }, a); t('unknown permission rejected', r.s === 400, r);
r = await call('PATCH', '/users/' + staffId, { permissions: ['users:read'] }, a); t('owner sets custom perms', r.s === 200, r);
r = await call('GET', '/users', null, st); t('staff now lists users (same token)', r.s === 200 && r.b.users.length === 4, r);
r = await call('DELETE', '/users/' + staffId, null, a); t('owner deactivates staff', r.s === 204, r);
r = await call('GET', '/company', null, st); t('deactivated staff locked out', r.s === 401 || r.s === 403, r);
r = await call('POST', '/auth/login', { email: 'staff@a.com', password: 'staff-pass-1' }); t('deactivated staff cannot login', r.s === 403, r);

// suspension cascades
r = await call('PATCH', '/admin/owners/' + aId, { isActive: false }, sa); t('SA suspends owner A', r.s === 200 && r.b.owner.isActive === false && r.b.owner.company.userCount === 3, r);
r = await call('GET', '/company', null, a); t('suspended owner blocked', r.s === 403, r);
r = await call('GET', '/company', null, ad); t('suspended company admin blocked', r.s === 403 && r.b.error.code === 'COMPANY_SUSPENDED', r);
r = await call('GET', '/company', null, b); t('company B unaffected', r.s === 200, r);
r = await call('PATCH', '/admin/owners/' + aId, { isActive: true, phone: '123' }, sa); t('SA reactivates', r.b.owner.isActive && r.b.owner.phone === '123' && r.b.owner.name === 'Owner A', r);
r = await call('GET', '/admin/owners?search=b@x', null, sa); t('SA search', r.b.owners.length === 1 && r.b.owners[0].createdVia === 'SELF', r);
r = await call('POST', '/admin/owners/' + aId + '/reset-password', null, sa); t('SA reset owner pw', r.s === 200, r);
r = await call('GET', '/company', null, a); t('owner token dead after reset', r.s === 401, r);
r = await call('PATCH', '/admin/owners/' + bStaffId, { isActive: false }, sa); t('SA owner route ignores non-owners', r.s === 404, r);
r = await call('GET', '/users/not-a-uuid', null, b); t('bad uuid 400', r.s === 400, r);
console.log(`\n${pass} passed, ${fail} failed`);
