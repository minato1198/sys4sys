UPDATE approvals
SET
  status = 'expired',
  decided_at = CAST(strftime('%s', 'now') AS integer) * 1000,
  note = '既存の重複 pending 承認を自動期限切れ'
WHERE
  status = 'pending'
  AND id NOT IN (
    SELECT (
      SELECT latest.id
      FROM approvals latest
      WHERE
        latest.status = 'pending'
        AND latest.incident_id = approvals.incident_id
      ORDER BY latest.requested_at DESC, latest.rowid DESC
      LIMIT 1
    )
  );
--> statement-breakpoint
CREATE UNIQUE INDEX `approvals_pending_incident_uq` ON `approvals` (`incident_id`) WHERE "approvals"."status" = 'pending';
