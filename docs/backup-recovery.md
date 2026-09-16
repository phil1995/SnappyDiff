# Backup and recovery

SnappyDiff separates metadata recovery from image recovery. D1 contains authoritative tenant, run, comparison, and image-key metadata; R2 contains private immutable PNG objects.

Before production, enable D1 point-in-time recovery and R2 object versioning (where supported), keep restore permission on a separate break-glass identity, inventory resource IDs outside application secrets, and run a quarterly restore exercise.

## Restore exercise

1. Stop writes by routing the environment to maintenance mode.
2. Restore D1 and R2 into new, isolated resources at the selected timestamp.
3. Run every checked-in migration against the restored database.
4. Compare `organization_usage.stored_bytes` with active `images.byte_size` totals.
5. Sample private images through the authenticated API and verify SHA-256 values against D1.
6. Point a staging Worker at the recovery resources and run smoke checks.
7. Change production bindings only after approval; preserve original resources until recovery is accepted.

Never copy a tenant's rows without their `organization_id` predicates and foreign-key closure. For a single-tenant legal recovery, restore the full database in isolation and use a reviewed offline export procedure.

Record timestamps, operators, resource IDs, reconciliation results, demonstrated recovery time, and follow-up actions without recording credentials.
