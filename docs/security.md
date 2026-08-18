# Security

AnonShock minimizes the information exposed to guests and the information retained by the
instance. It stores link definitions but no request log, command log, guest history, account, or
raw IP address. Upstream credentials and identifiers stored in the database are encrypted.

Production traffic reaches the application through Cloudflare Tunnel and a Unix socket. The public
origin and OpenShock upstream must use HTTPS. Responses include HSTS, a restrictive content
security policy, no-store caching, and anti-framing protections.

ALTCHA is self-hosted and optional. It adds proof of work before protected actions without sending
guest data to a CAPTCHA provider. Per-IP, per-session, and per-link limits provide additional abuse
controls. Per-IP limits are only as trustworthy as `TRUST_PROXY` says they are; see
[deployment](deployment.md). Stop commands remain available when ordinary control is blocked, and
are never rate limited: a stop repeated inside a quarter second is answered from the one already
delivered rather than refused.

AnonShock hides the device owner's OpenShock identity from guests. It does not make guests
anonymous to the network operator or OpenShock, and the device owner can see submitted commands in
OpenShock. Operators are responsible for access control, backups, Cloudflare configuration, host
security, and compliance with the [OpenShock safety rules](https://wiki.openshock.org/home/safety-rules).
