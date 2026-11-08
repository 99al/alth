# Bot 2 member replacement queue

Only the service whose `BOT_COMMAND_PROFILE` resolves to `second` initializes this feature. In a group, a current bot administrator can queue an account with `ضيف <ID>`; each command queues one numeric Facebook ID for that group. Queue order is FIFO and an ID is never retried in that group, including after failure, timeout, or process restart. The queue is private durable state under `/data/alth-member-compensation/<service>.json` in production (local development uses `.member-queue/state.json`).

After an actual `event`/`log:unsubscribe`, Bot 2 fetches a fresh group snapshot. Replacement is eligible only when it contains exactly 249 unique participant IDs and excludes the valid leaver. A queued ID already in the group is consumed as a skip; at most one other nonmember is attempted. Approval-required groups are left untouched and the queue is retained. The feature does not bypass Messenger invitation, approval, or membership restrictions. An FCA acknowledgement is not proof of membership; administrators are notified when membership is confirmed or when the API only acknowledges an invitation/request.

The implementation depends on the unofficial FCA `getThreadInfo`, `addUserToGroup`, and `sendMessage` methods. Their availability and behavior are not guaranteed by Meta. Uncertain timeouts or crashes are deliberately not retried. State corruption or unavailable durable storage fails closed.

## Deployment and safety

Run only on Bot 2 with `BOT_COMMAND_PROFILE=second`, one active service process/replica, and a persistent Railway volume mounted at `/data`. Other profiles do not initialize the queue. In-process locks are not distributed locks; multiple simultaneous replicas are unsupported. Keep the existing volume on redeployment.

This command queues an account; it does not immediately add it. A valid departure plus a fresh 249-member snapshot is the eligibility check. Events without a stable message ID/timestamp are conservatively deduplicated by leaver; a repeated departure by that account may therefore be ignored rather than risk repeating an old event. Processed events and consumed account IDs are retained indefinitely. A storage failure stops further queue effects until the process restarts with readable state. Notifications identify the group and go to the currently saved bot admins.

Run `npm run check` and `npm test` before deployment. The queue tests include callback-only and Promise APIs, timeouts, failure responses, concurrent duplicate events, restart recovery, private on-disk storage, approval mode, group isolation, and main-runtime profile gating. They use simulated APIs; no live Messenger invitation is performed by tests.
