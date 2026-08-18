# Usage

## Create a link

1. Open **Make a link**.
2. Choose an OpenShock share link or API token.
3. Review the discovered hubs and shockers.
4. Configure names, limits, permissions, expiry, rate limits, and the optional bot check.
5. Review every setting and create the link.
6. Save the guest URL, management URL, and recovery string.

Set either commands-per-minute limit to 0 to make that scope unlimited. Per-shocker cooldowns still
apply.

API tokens are sent only to the configured OpenShock API and are stored encrypted by the AnonShock
instance. Revoke a token in OpenShock when it is no longer needed.

## Manage links

**Your links** lists links created by the current browser. A link can be paused, resumed, opened,
or managed there. The management page can narrow limits, disable permissions, refresh upstream
devices, rotate the guest URL, pause the link, or delete it.

Use the recovery field on **Your links** to restore creator access in another browser.

## Guest controls

Before the first command, the guest must acknowledge the configured limits and privacy notice. If
the creator enabled the bot check, the guest must also complete ALTCHA. The owner can see commands
in OpenShock; AnonShock does not keep a command log.

Follow the [OpenShock safety rules](https://wiki.openshock.org/home/safety-rules).
