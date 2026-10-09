# Sign-in: email and password

Everyone signs in with an **email and a password**: the dashboard, the booth worker app (`/w`) and the results app (`/r`). The earlier sign-in by phone number and one-time code is gone (the `otp_codes` table is dropped and `OTP_PROVIDER`, `DLT_OTP_*` and `DEV_RETURN_OTP` no longer exist).

## Who can do what

| Account | What it is | How it is made |
| --- | --- | --- |
| **Super admin** | Manages accounts: creates admins and users, disables them, resets passwords. Also has all admin powers. | The first one from `SUPERADMIN_EMAIL` + `SUPERADMIN_PASSWORD` at startup (only while none exists), or `pnpm --filter @cs/api create-superadmin <email> [name]`. After that, another super admin. |
| **Admin** | Platform staff: packages and pricing, support access to campaigns (read only, with a stated reason), agencies. | Created by a super admin. |
| **User** | No platform powers. A candidate signs in and creates their campaign; team members are added by the campaign owner and get a role in that campaign. | Created by a super admin, or by a campaign owner adding a team member by email. |

Open `/admin`, sign in as a super admin, and use **Super admin: accounts**. Creating an account has three ways to give the person their password:
1. **Generate one**: shown once; hand it over privately.
2. **Type one yourself.**
3. **Email a link** so they choose their own (only if email is set up: `SMTP_URL`).

A password someone else chose (generated, typed, or an admin reset) is **temporary**: the person must choose their own at first sign-in, and nothing else works until they do.

## Forgot password

On the sign-in page, **Forgot your password?** asks for the email and sends a link (`/admin/reset-password?token=...`). The answer is the same whether or not the email has an account, so it cannot be used to find out who has one. The link works **once, for one hour**; only a hash of it is stored; a newer link cancels older ones; asking again is limited to 3 per hour per email. Setting a new password signs the person out on every device. A super admin can also reset a password directly or email the link.

## Rules

- Passwords: at least 10 characters (up to 128), not an obvious one, and not containing the email. Stored as an scrypt hash with a per-password salt.
- Sign-in attempts are limited per account (20 per 15 minutes) and per IP address (`LOGIN_MAX_PER_IP`, default 30 per 10 minutes). A wrong password, an unknown email and a disabled account all get the same answer in the same time.
- Disabling an account signs it out everywhere at once. There is always at least one active super admin, and nobody can disable or demote themselves.
- Everything a super admin does is in the audit log.
- Team members can still have a **phone number**, used only so a polling agent's text message is matched to their account. It is optional.

## Settings

| Setting | Meaning |
| --- | --- |
| `SMTP_URL`, `MAIL_FROM` | Where password emails go and who they come from. **Optional.** Without `SMTP_URL` in production, "Forgot password" and email invites are switched off (the sign-in page says to ask an administrator; a super admin resets passwords with "New password"; team members must be given a password when added). In development the emails are written to the API log instead. |
| `SUPERADMIN_EMAIL`, `SUPERADMIN_PASSWORD` | Creates the first super admin at startup while none exists. Remove the password after the first sign-in. |
| `DEV_RETURN_RESET_TOKEN` | Demo servers only: the forgot-password answer includes the token. Refused in production. |
| `LOGIN_MAX_PER_IP` | Sign-in attempts per IP address per 10 minutes. |

## Moving existing accounts

Accounts that only had a phone number cannot sign in any more. A super admin creates an account (email + password) for each person; if someone is added to a campaign team by the same email later, they keep one account. People added to a team before this change need a super admin to create their email account and an owner to add them to the team again.

## Not done

- Two-factor authentication.
- Sign-in with Google or other providers.
- Self-service sign-up (accounts are created by a super admin, or by an owner adding a team member).
- Password history (reusing an old password) and expiry.
