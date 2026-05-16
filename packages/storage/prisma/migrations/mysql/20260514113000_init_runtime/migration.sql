-- CreateTable
CREATE TABLE `pi_agent_sessions` (
    `id` VARCHAR(64) NOT NULL,
    `tenant_id` VARCHAR(64) NOT NULL,
    `user_id` VARCHAR(64) NOT NULL,
    `workspace_id` VARCHAR(128) NULL,
    `session_id` VARCHAR(160) NOT NULL,
    `conversation_id` VARCHAR(160) NOT NULL,
    `root_session_id` VARCHAR(160) NULL,
    `parent_session_id` VARCHAR(160) NULL,
    `child_session_id` VARCHAR(160) NULL,
    `task_run_id` VARCHAR(64) NULL,
    `run_id` VARCHAR(64) NULL,
    `spawn_batch_id` VARCHAR(64) NULL,
    `trigger_type` VARCHAR(32) NOT NULL,
    `status` VARCHAR(32) NOT NULL,
    `title` VARCHAR(255) NULL,
    `turn_count` BIGINT NOT NULL DEFAULT 0,
    `first_user_message` TEXT NULL,
    `last_user_message` TEXT NULL,
    `last_assistant_message` TEXT NULL,
    `last_message_at` DATETIME(6) NULL,
    `model_provider` VARCHAR(64) NOT NULL,
    `model_name` VARCHAR(128) NOT NULL,
    `thinking_level` VARCHAR(32) NULL,
    `tool_policy_profile` VARCHAR(64) NOT NULL,
    `sandbox_session_id` VARCHAR(160) NULL,
    `sandbox_status` VARCHAR(32) NULL,
    `pi_session_ref` VARCHAR(512) NULL,
    `metadata_json` JSON NULL,
    `created_at` DATETIME(6) NOT NULL,
    `updated_at` DATETIME(6) NOT NULL,
    `last_active_at` DATETIME(6) NULL,
    `archived_at` DATETIME(6) NULL,
    `deleted_at` DATETIME(6) NULL,

    INDEX `idx_pi_agent_sessions_user_updated`(`tenant_id`, `user_id`, `updated_at`),
    INDEX `idx_pi_agent_sessions_workspace_updated`(`tenant_id`, `workspace_id`, `updated_at`),
    INDEX `idx_pi_agent_sessions_user_last_message`(`tenant_id`, `user_id`, `last_message_at`),
    INDEX `idx_pi_agent_sessions_user_visible`(`tenant_id`, `user_id`, `deleted_at`, `last_message_at`),
    INDEX `idx_pi_agent_sessions_parent`(`tenant_id`, `parent_session_id`),
    INDEX `idx_pi_agent_sessions_status`(`tenant_id`, `status`),
    UNIQUE INDEX `uq_pi_agent_sessions_session`(`session_id`),
    UNIQUE INDEX `uq_pi_agent_sessions_tenant_session`(`tenant_id`, `session_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `pi_agent_turns` (
    `id` VARCHAR(64) NOT NULL,
    `tenant_id` VARCHAR(64) NOT NULL,
    `user_id` VARCHAR(64) NOT NULL,
    `workspace_id` VARCHAR(128) NULL,
    `session_id` VARCHAR(160) NOT NULL,
    `conversation_id` VARCHAR(160) NOT NULL,
    `trace_id` VARCHAR(64) NULL,
    `turn_seq` BIGINT NOT NULL,
    `source_type` VARCHAR(32) NOT NULL,
    `status` VARCHAR(32) NOT NULL,
    `input_text` LONGTEXT NULL,
    `input_json` JSON NULL,
    `output_text` LONGTEXT NULL,
    `output_json` JSON NULL,
    `error_json` JSON NULL,
    `model_json` JSON NULL,
    `tool_policy_profile` VARCHAR(64) NULL,
    `started_at` DATETIME(6) NULL,
    `completed_at` DATETIME(6) NULL,
    `created_at` DATETIME(6) NOT NULL,
    `updated_at` DATETIME(6) NOT NULL,

    INDEX `idx_pi_agent_turns_session_seq`(`tenant_id`, `session_id`, `turn_seq`),
    INDEX `idx_pi_agent_turns_user_created`(`tenant_id`, `user_id`, `created_at`),
    INDEX `idx_pi_agent_turns_trace`(`tenant_id`, `trace_id`),
    INDEX `idx_pi_agent_turns_status`(`tenant_id`, `status`, `created_at`),
    UNIQUE INDEX `uq_pi_agent_turns_tenant_session_seq`(`tenant_id`, `session_id`, `turn_seq`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `pi_agent_messages` (
    `id` VARCHAR(64) NOT NULL,
    `tenant_id` VARCHAR(64) NOT NULL,
    `user_id` VARCHAR(64) NOT NULL,
    `workspace_id` VARCHAR(128) NULL,
    `session_id` VARCHAR(160) NOT NULL,
    `conversation_id` VARCHAR(160) NOT NULL,
    `turn_id` VARCHAR(64) NULL,
    `role` VARCHAR(32) NOT NULL,
    `agent_id` VARCHAR(160) NULL,
    `content_text` LONGTEXT NULL,
    `content_json` JSON NULL,
    `thoughts_json` JSON NULL,
    `tool_calls_json` JSON NULL,
    `token_usage_json` JSON NULL,
    `model_provider` VARCHAR(64) NULL,
    `model_name` VARCHAR(128) NULL,
    `message_seq` BIGINT NOT NULL,
    `created_at` DATETIME(6) NOT NULL,
    `deleted_at` DATETIME(6) NULL,

    INDEX `idx_pi_agent_messages_session_seq`(`tenant_id`, `session_id`, `message_seq`),
    INDEX `idx_pi_agent_messages_turn`(`tenant_id`, `turn_id`),
    INDEX `idx_pi_agent_messages_user_created`(`tenant_id`, `user_id`, `created_at`),
    UNIQUE INDEX `uq_pi_agent_messages_tenant_session_seq`(`tenant_id`, `session_id`, `message_seq`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `pi_agent_turn_queue` (
    `id` VARCHAR(64) NOT NULL,
    `tenant_id` VARCHAR(64) NOT NULL,
    `user_id` VARCHAR(64) NOT NULL,
    `workspace_id` VARCHAR(128) NULL,
    `session_id` VARCHAR(160) NOT NULL,
    `turn_id` VARCHAR(64) NOT NULL,
    `source_type` VARCHAR(32) NOT NULL,
    `status` VARCHAR(32) NOT NULL,
    `priority` INTEGER NOT NULL DEFAULT 0,
    `lease_owner` VARCHAR(128) NULL,
    `lease_expires_at` DATETIME(6) NULL,
    `attempt_count` INTEGER NOT NULL DEFAULT 0,
    `available_at` DATETIME(6) NOT NULL,
    `created_at` DATETIME(6) NOT NULL,
    `updated_at` DATETIME(6) NOT NULL,

    INDEX `idx_pi_agent_turn_queue_ready`(`tenant_id`, `status`, `priority`, `available_at`),
    INDEX `idx_pi_agent_turn_queue_ready_order`(`tenant_id`, `status`, `priority`, `available_at`, `created_at`),
    INDEX `idx_pi_agent_turn_queue_session`(`tenant_id`, `session_id`, `status`),
    INDEX `idx_pi_agent_turn_queue_source`(`tenant_id`, `source_type`, `status`),
    INDEX `idx_pi_agent_turn_queue_lease`(`tenant_id`, `lease_owner`, `lease_expires_at`),
    UNIQUE INDEX `uq_pi_agent_turn_queue_turn`(`tenant_id`, `turn_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `pi_agent_turn_signals` (
    `id` VARCHAR(64) NOT NULL,
    `tenant_id` VARCHAR(64) NOT NULL,
    `user_id` VARCHAR(64) NOT NULL,
    `actor_user_id` VARCHAR(64) NULL,
    `session_id` VARCHAR(160) NOT NULL,
    `turn_id` VARCHAR(64) NULL,
    `signal_type` VARCHAR(32) NOT NULL,
    `status` VARCHAR(32) NOT NULL,
    `payload_json` JSON NULL,
    `reason` VARCHAR(512) NULL,
    `created_at` DATETIME(6) NOT NULL,
    `delivered_at` DATETIME(6) NULL,
    `acknowledged_at` DATETIME(6) NULL,

    INDEX `idx_pi_agent_turn_signals_session`(`tenant_id`, `session_id`, `status`, `created_at`),
    INDEX `idx_pi_agent_turn_signals_turn`(`tenant_id`, `turn_id`, `status`),
    INDEX `idx_pi_agent_turn_signals_actor`(`tenant_id`, `actor_user_id`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `pi_agent_events` (
    `id` VARCHAR(64) NOT NULL,
    `tenant_id` VARCHAR(64) NOT NULL,
    `user_id` VARCHAR(64) NULL,
    `workspace_id` VARCHAR(128) NULL,
    `session_id` VARCHAR(160) NULL,
    `turn_id` VARCHAR(64) NULL,
    `trace_id` VARCHAR(64) NULL,
    `event_seq` BIGINT NOT NULL,
    `event_source` VARCHAR(32) NOT NULL,
    `event_type` VARCHAR(64) NOT NULL,
    `event_name` VARCHAR(64) NOT NULL,
    `severity` VARCHAR(16) NOT NULL DEFAULT 'info',
    `payload_json` JSON NULL,
    `created_at` DATETIME(6) NOT NULL,

    INDEX `idx_pi_agent_events_session_seq`(`tenant_id`, `session_id`, `event_seq`),
    INDEX `idx_pi_agent_events_session_created`(`tenant_id`, `session_id`, `created_at`),
    INDEX `idx_pi_agent_events_turn_seq`(`tenant_id`, `turn_id`, `event_seq`),
    INDEX `idx_pi_agent_events_turn_created`(`tenant_id`, `turn_id`, `created_at`),
    INDEX `idx_pi_agent_events_trace_created`(`tenant_id`, `trace_id`, `created_at`),
    INDEX `idx_pi_agent_events_type_created`(`tenant_id`, `event_type`, `created_at`),
    INDEX `idx_pi_agent_events_source_session_seq`(`tenant_id`, `event_source`, `session_id`, `event_seq`),
    INDEX `idx_pi_agent_events_source_trace_created`(`tenant_id`, `event_source`, `trace_id`, `created_at`),
    INDEX `idx_pi_agent_events_source_type_created`(`tenant_id`, `event_source`, `event_type`, `created_at`),
    UNIQUE INDEX `uq_pi_agent_events_tenant_session_seq`(`tenant_id`, `session_id`, `event_seq`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `pi_agent_subagent_runs` (
    `id` VARCHAR(64) NOT NULL,
    `tenant_id` VARCHAR(64) NOT NULL,
    `user_id` VARCHAR(64) NOT NULL,
    `workspace_id` VARCHAR(128) NULL,
    `run_id` VARCHAR(64) NOT NULL,
    `task_run_id` VARCHAR(64) NULL,
    `spawn_batch_id` VARCHAR(64) NULL,
    `trace_id` VARCHAR(64) NULL,
    `parent_session_id` VARCHAR(160) NOT NULL,
    `child_session_id` VARCHAR(160) NOT NULL,
    `parent_turn_id` VARCHAR(64) NULL,
    `parent_tool_call_id` VARCHAR(160) NULL,
    `agent_name` VARCHAR(128) NULL,
    `label` VARCHAR(255) NULL,
    `task_text` LONGTEXT NOT NULL,
    `status` VARCHAR(32) NOT NULL,
    `depth` INTEGER NOT NULL DEFAULT 0,
    `model_json` JSON NULL,
    `tool_policy_profile` VARCHAR(64) NULL,
    `result_text` LONGTEXT NULL,
    `error_json` JSON NULL,
    `created_at` DATETIME(6) NOT NULL,
    `started_at` DATETIME(6) NULL,
    `ended_at` DATETIME(6) NULL,
    `updated_at` DATETIME(6) NOT NULL,

    INDEX `idx_pi_agent_subagent_runs_parent`(`tenant_id`, `parent_session_id`, `status`),
    INDEX `idx_pi_agent_subagent_runs_child`(`tenant_id`, `child_session_id`),
    INDEX `idx_pi_agent_subagent_runs_trace`(`tenant_id`, `trace_id`),
    UNIQUE INDEX `uq_pi_agent_subagent_runs_run_global`(`run_id`),
    UNIQUE INDEX `uq_pi_agent_subagent_runs_run`(`tenant_id`, `run_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `pi_agent_approvals` (
    `id` VARCHAR(64) NOT NULL,
    `tenant_id` VARCHAR(64) NOT NULL,
    `user_id` VARCHAR(64) NOT NULL,
    `actor_user_id` VARCHAR(64) NULL,
    `workspace_id` VARCHAR(128) NULL,
    `session_id` VARCHAR(160) NOT NULL,
    `turn_id` VARCHAR(64) NULL,
    `tool_call_id` VARCHAR(160) NULL,
    `approval_type` VARCHAR(64) NOT NULL,
    `status` VARCHAR(32) NOT NULL,
    `request_json` JSON NOT NULL,
    `decision_json` JSON NULL,
    `requested_at` DATETIME(6) NOT NULL,
    `decided_at` DATETIME(6) NULL,
    `expires_at` DATETIME(6) NULL,

    INDEX `idx_pi_agent_approvals_session`(`tenant_id`, `session_id`, `status`, `requested_at`),
    INDEX `idx_pi_agent_approvals_actor`(`tenant_id`, `actor_user_id`, `requested_at`),
    INDEX `idx_pi_agent_approvals_expiry`(`tenant_id`, `status`, `expires_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `pi_agent_memory` (
    `id` VARCHAR(64) NOT NULL,
    `tenant_id` VARCHAR(64) NOT NULL,
    `user_id` VARCHAR(64) NOT NULL,
    `workspace_id` VARCHAR(128) NULL,
    `session_id` VARCHAR(160) NULL,
    `scope` VARCHAR(32) NOT NULL,
    `text` LONGTEXT NOT NULL,
    `tags_json` JSON NULL,
    `metadata_json` JSON NULL,
    `embedding_ref` VARCHAR(256) NULL,
    `created_at` DATETIME(6) NOT NULL,
    `updated_at` DATETIME(6) NOT NULL,
    `deleted_at` DATETIME(6) NULL,

    INDEX `idx_pi_agent_memory_session`(`tenant_id`, `session_id`, `created_at`),
    INDEX `idx_pi_agent_memory_user_scope`(`tenant_id`, `user_id`, `scope`, `created_at`),
    INDEX `idx_pi_agent_memory_workspace_scope`(`tenant_id`, `workspace_id`, `scope`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `pi_agent_scheduled_tasks` (
    `id` VARCHAR(64) NOT NULL,
    `tenant_id` VARCHAR(64) NOT NULL,
    `user_id` VARCHAR(64) NOT NULL,
    `workspace_id` VARCHAR(128) NULL,
    `session_id` VARCHAR(160) NOT NULL,
    `name` VARCHAR(255) NULL,
    `description` TEXT NULL,
    `prompt` LONGTEXT NOT NULL,
    `task_type` VARCHAR(32) NOT NULL,
    `schedule` VARCHAR(255) NULL,
    `interval_seconds` INTEGER NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `model_json` JSON NULL,
    `tool_policy_profile` VARCHAR(64) NULL,
    `workspace_dir` VARCHAR(1024) NULL,
    `last_run_at` DATETIME(6) NULL,
    `next_run_at` DATETIME(6) NULL,
    `run_count` BIGINT NOT NULL DEFAULT 0,
    `last_status` VARCHAR(32) NULL,
    `last_error` TEXT NULL,
    `created_at` DATETIME(6) NOT NULL,
    `updated_at` DATETIME(6) NOT NULL,
    `deleted_at` DATETIME(6) NULL,

    INDEX `idx_pi_agent_scheduled_tasks_due`(`tenant_id`, `enabled`, `next_run_at`),
    INDEX `idx_pi_agent_scheduled_tasks_user`(`tenant_id`, `user_id`, `updated_at`),
    INDEX `idx_pi_agent_scheduled_tasks_user_visible`(`tenant_id`, `user_id`, `deleted_at`, `updated_at`),
    INDEX `idx_pi_agent_scheduled_tasks_session`(`tenant_id`, `session_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `pi_agent_task_runs` (
    `id` VARCHAR(64) NOT NULL,
    `tenant_id` VARCHAR(64) NOT NULL,
    `user_id` VARCHAR(64) NOT NULL,
    `workspace_id` VARCHAR(128) NULL,
    `task_id` VARCHAR(64) NOT NULL,
    `session_id` VARCHAR(160) NOT NULL,
    `turn_id` VARCHAR(64) NULL,
    `status` VARCHAR(32) NOT NULL,
    `message` TEXT NULL,
    `error_json` JSON NULL,
    `started_at` DATETIME(6) NULL,
    `ended_at` DATETIME(6) NULL,
    `created_at` DATETIME(6) NOT NULL,

    INDEX `idx_pi_agent_task_runs_task_created`(`tenant_id`, `task_id`, `created_at`),
    INDEX `idx_pi_agent_task_runs_status_created`(`tenant_id`, `status`, `created_at`),
    INDEX `idx_pi_agent_task_runs_turn`(`tenant_id`, `turn_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `pi_agent_artifacts` (
    `id` VARCHAR(64) NOT NULL,
    `tenant_id` VARCHAR(64) NOT NULL,
    `user_id` VARCHAR(64) NOT NULL,
    `workspace_id` VARCHAR(128) NULL,
    `session_id` VARCHAR(160) NOT NULL,
    `turn_id` VARCHAR(64) NULL,
    `tool_call_id` VARCHAR(160) NULL,
    `artifact_type` VARCHAR(64) NOT NULL,
    `name` VARCHAR(512) NULL,
    `mime_type` VARCHAR(128) NULL,
    `size_bytes` BIGINT NULL,
    `sha256` VARCHAR(64) NULL,
    `storage_uri` VARCHAR(1024) NOT NULL,
    `preview_uri` VARCHAR(1024) NULL,
    `metadata_json` JSON NULL,
    `created_at` DATETIME(6) NOT NULL,
    `deleted_at` DATETIME(6) NULL,

    INDEX `idx_pi_agent_artifacts_session_created`(`tenant_id`, `session_id`, `created_at`),
    INDEX `idx_pi_agent_artifacts_user_session_visible`(`tenant_id`, `user_id`, `deleted_at`, `session_id`, `created_at`),
    INDEX `idx_pi_agent_artifacts_turn_created`(`tenant_id`, `turn_id`, `created_at`),
    INDEX `idx_pi_agent_artifacts_tool_call`(`tenant_id`, `tool_call_id`),
    INDEX `idx_pi_agent_artifacts_hash`(`tenant_id`, `sha256`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
