# FCM topic subscription API migration

This server uses `petyard-dev`. Its broadcast topic subscriptions must move from
the Instance ID API to the FCM v1 topic subscription API before September 29,
2027. Firebase Admin SDK 14.5.0 makes that change in `subscribeToTopic()`.

## Before cutover

1. Grant `firebase-adminsdk-fbsvc@petyard-dev.iam.gserviceaccount.com` the
   `roles/firebasecloudmessaging.admin` role on `petyard-dev`. A canary with the
   new SDK returned HTTP 403 `IAM_PERMISSION_DENIED` until this is done.
2. Use Node 22 or newer. This server has a checksum verified Node 22.23.3 at
   `/root/.local/opt/node-v22.23.3-linux-x64/bin/node`. Do not replace the
   system Node 20 binary to deploy this change.
3. From `/root/Petyard`, run the canary with the staged checkout before any
   process switch:

   ```sh
   FCM_CANARY_PROJECT_ID=petyard-dev /root/.local/opt/node-v22.23.3-linux-x64/bin/node /root/Petyard-fcm-v1/scripts/checkFcmTopicMigration.mjs
   ```

   The canary tries up to five recent device tokens until one is subscribed to
   its existing broadcast bucket. It sends no notification and prints no device
   token. Stop the
   rollout if it fails.
4. Record the current Git commit and PM2 status. Confirm `GET /` on localhost
   port 3000 returns HTTP 200. Keep the old `node_modules` directory for
   rollback. The release modules have been clean installed and tested under
   Node 22 in `/root/Petyard-fcm-v1`.

## Cutover

1. Bring the reviewed migration commit into `/root/Petyard` only while its Git
   tree is clean. Copy the staged `node_modules` to a release directory before
   switching the live dependency directory. Retain the old directory.
2. Restart PM2 from `ecosystem.config.cjs`. On this server it selects the
   installed Node 22 binary; `PETYARD_NODE_BIN` can override the interpreter on
   another server. Restart all four workers one at a time, then the API process
   last. Check each process is online and reports Node 22.
3. Verify `GET /` returns HTTP 200. Run the canary again from `/root/Petyard`
   using the same Node 22 binary and `FCM_CANARY_PROJECT_ID=petyard-dev`.
   Set `FCM_CANARY_DRY_RUN_SEND=true` to validate one direct and one topic send
   without delivering messages.
4. Save the PM2 process list only after every check passes, so reboots retain
   the Node 22 interpreter. Monitor subscription failures and push sends.

## Rollback

If any PM2 process fails or the API health check fails, restore the recorded
Git commit and old `node_modules` directory, then restart the affected PM2
processes with `/usr/bin/node`. Verify API health and the process list before
ending the incident. Do not run the full broadcast topic sync as a migration
step; existing subscriptions remain in FCM.

## Deployment record: September 28, 2026

- Previous commit: `b0f71975215c36ad09224d6a7f50a921516d6bb3`.
- Migration commit: `de65a4f`; dry-run check commit: `0ea2e89`.
- Previous dependencies are at
  `/root/.local/releases/petyard-fcm-v1-de65a4f/node_modules-old`.
- The live repository uses Firebase Admin SDK 14.5.0. All five PM2 processes
  report Node 22.23.3. `pm2 save` recorded the absolute Node 22 interpreter,
  and the existing `pm2-root` systemd startup service is enabled and active.
- Verification passed: 54 tests in the isolated checkout, local API HTTP 200,
  topic subscription canary, direct send dry run, and topic send dry run.
