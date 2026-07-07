# 2026-07-07 Vector Weather Operations Record

This note records the production documentation, deployment, email, and infrastructure work completed on July 7, 2026.

## Anchor Weather / Vector Weather Documentation

- Refreshed user-facing documentation to match what is deployed in production.
- Updated the logged-in landing page `What's New` and `On The Horizon` sections.
- Updated supporting project documentation, including user guide, SignalK API key notes, architecture, and system diagrams.
- Regenerated frontend user-guide content and verified the frontend build.
- Committed and pushed the work in `anchor-weather`.
- Opened PR: `hackmare/anchor-weather#142`.
- GitHub rejected self-approval because the PR author cannot approve their own PR.

Verification:

- `npm run sync:guide:check`
- `npm run build`

## Vector Weather Notification Sender

- Changed the Vector Weather notification sender to:
  - From name: `Vector Weather`
  - From email: `info@selkietech.ca`
- Scoped the production environment change to `corporate-network/anchor-weather-notifications/.env`.
- Did not change `/root/roitsystems-infra/.env`, because other RO IT Systems senders still use RO IT Systems addresses.
- Rebuilt and recreated only the `anchor-weather-notifications` service.
- Verified the running container environment showed the new sender name and email.
- Sent a test email after the sender change and confirmed it was delivered through worker logs.
- Committed and pushed the sender update in `roitsystems-infra`.
- Opened PR: `hackmare/roitsystems-infra#5`.
- GitHub rejected self-approval because the PR author cannot approve their own PR.

## Early-Adopter User Email Campaign

- Drafted and tested the Vector Weather early-adopter update email.
- The approved email thanked users for being early adopters, acknowledged bugs, highlighted recent improvements, and pointed users to documentation.
- Included the requested note that logged-out users may need to sign in and then click the same link again.
- Sent the approved email through production NATS subject `anchor.weather.user.comms`.
- Pulled recipients from the production `users` table.
- Sent the campaign to 19 distinct registered users.
- Verified the notification worker logged 19 `Email sent` entries and no failures.

The campaign highlighted:

- SignalK station notes for the OpenPlotter open-source navigation chart plotter.
- More than 3,000 live weather observation stations.
- Improved forecast fitting to observed conditions.
- Increased tide and current modelling reliability.
- Marine weather improvements.
- River-bar modelling.
- Tide observations.
- Coastal Pilot and Sailing Directions for Canada and the US.
- Route send-to-boat hardening.
- Persisted observation pollers.
- More forecast model cross-checks.
- The `/conditions` page for browsing conditions across the Salish Sea and BC coast.
- Reduced platform operating cost.

## `roitsystems-ca` Deployment

- A manual DigitalOcean App Platform deployment was triggered for `roitsystems-ca` before the target was clarified.
- Deployment ID: `82406ae4-2d83-4b05-9727-b75873dda546`.
- The deployment became active successfully.
- Verified `https://roitsystems.ca/` returned HTTP 200 and served the expected RO IT Systems page.

## `roitsystems-admin` Deployment

- Clarified that `roitsystems-admin` refers to the `contact-inbox` admin stack in `roitsystems-infra`.
- Confirmed production admin access is served via:
  - `https://pubapi.roitsystems.ca/corporate-network/contact`
- Fast-forwarded the production checkout to `origin/main` after PR #5 had been merged.
- Rebuilt and recreated the `contact-inbox` stack.

Initial deployment issue:

- `contact-inbox-api` restarted after rebuild.
- Logs showed `@fastify/cookie` expected Fastify 4, while the dependency bump had installed Fastify 5.8.5.
- The API failed with `FST_ERR_PLUGIN_VERSION_MISMATCH`.

Hotfix:

- Pinned `corporate-network/contact-inbox/api` back to Fastify 4.
- Regenerated the API package lockfile.
- Verified the API TypeScript build locally.
- Copied the patched package files to production.
- Rebuilt and restarted `contact-inbox-api`.
- Verified the API container returned to healthy state.
- Pushed branch `fix/contact-inbox-fastify-compat`.
- Opened PR: `hackmare/roitsystems-infra#6`.
- GitHub rejected self-approval because the PR author cannot approve their own PR.

Verification:

- `contact-inbox-api` container status: healthy.
- `https://pubapi.roitsystems.ca/health` returned HTTP 200.
- `https://pubapi.roitsystems.ca/corporate-network/contact` returned HTTP 302 to Google login, as expected for unauthenticated access.
- `https://pubapi.roitsystems.ca/api/admin/messages` returned HTTP 302 to Google login, as expected for unauthenticated access.

## Follow-Up Notes

- PR `hackmare/roitsystems-infra#6` should be merged so the production Fastify hotfix is represented on `main`.
- The server currently has the Fastify hotfix applied while that PR is open.
- The obsolete `version` warning from Docker Compose is informational and did not block deployment.
