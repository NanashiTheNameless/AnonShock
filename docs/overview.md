# Overview

AnonShock creates privacy-preserving control links for OpenShock devices. A guest sees only names
and limits chosen for that link. OpenShock usernames, device names, IDs, avatars, and credentials
are not shown.

Links can be created from an OpenShock share link or an API token. API-token mode only lists
shockers owned by that token's user. Each shocker can be renamed, limited, permitted for selected
actions, or hidden.

AnonShock has no user accounts and stores no command history. The creator's browser receives a
holder cookie for its links and a recovery string for moving that access to another browser.

The project is self-hosted and intended to run as a Docker Compose stack behind Cloudflare Tunnel.
