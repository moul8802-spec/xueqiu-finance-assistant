import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const sources = sqliteTable(
  'sources',
  {
    id: text('id').primaryKey(),
    chatId: text('chat_id').notNull(),
    name: text('name').notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [uniqueIndex('idx_sources_chat_id').on(table.chatId)],
);

export const messages = sqliteTable(
  'messages',
  {
    id: text('id').primaryKey(),
    eventId: text('event_id').notNull(),
    messageId: text('message_id').notNull(),
    chatId: text('chat_id').notNull(),
    senderId: text('sender_id'),
    sanitizedContent: text('sanitized_content').notNull(),
    contentHash: text('content_hash').notNull(),
    status: text('status').notNull(),
    duplicateOf: text('duplicate_of'),
    receivedAt: integer('received_at').notNull(),
  },
  (table) => [
    uniqueIndex('idx_messages_event_id').on(table.eventId),
    uniqueIndex('idx_messages_message_id').on(table.messageId),
    index('idx_messages_hash_received').on(table.contentHash, table.receivedAt),
  ],
);

export const drafts = sqliteTable(
  'drafts',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    status: text('status').notNull().default('pending'),
    category: text('category').notNull(),
    topicKey: text('topic_key').notNull(),
    sourceChatId: text('source_chat_id').notNull(),
    sourceLabel: text('source_label').notNull(),
    sourceMessageIds: text('source_message_ids').notNull(),
    reviewFlags: text('review_flags').notNull().default('[]'),
    metadataJson: text('metadata_json').notNull().default('{}'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    reviewedAt: integer('reviewed_at'),
  },
  (table) => [
    index('idx_drafts_status_updated').on(table.status, table.updatedAt),
    index('idx_drafts_merge_window').on(table.sourceChatId, table.topicKey, table.createdAt),
  ],
);

export const auditLogs = sqliteTable(
  'audit_logs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    action: text('action').notNull(),
    actor: text('actor').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    detailsJson: text('details_json').notNull().default('{}'),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [index('idx_audit_logs_created').on(table.createdAt)],
);

export const feishuConnections = sqliteTable('feishu_connections', {
  actorId: text('actor_id').primaryKey(),
  feishuOpenId: text('feishu_open_id'),
  feishuUnionId: text('feishu_union_id'),
  tenantKey: text('tenant_key'),
  name: text('name'),
  avatarUrl: text('avatar_url'),
  accessTokenEnc: text('access_token_enc').notNull(),
  refreshTokenEnc: text('refresh_token_enc'),
  tokenType: text('token_type').notNull().default('Bearer'),
  scope: text('scope').notNull().default(''),
  expiresAt: integer('expires_at').notNull(),
  refreshExpiresAt: integer('refresh_expires_at'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const feishuOauthStates = sqliteTable(
  'feishu_oauth_states',
  {
    stateHash: text('state_hash').primaryKey(),
    actorId: text('actor_id').notNull(),
    redirectUri: text('redirect_uri').notNull(),
    expiresAt: integer('expires_at').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [index('idx_feishu_oauth_states_actor').on(table.actorId, table.expiresAt)],
);

export const feishuSelectedChats = sqliteTable('feishu_selected_chats', {
  actorId: text('actor_id').primaryKey(),
  chatId: text('chat_id').notNull(),
  name: text('name').notNull(),
  external: integer('external', { mode: 'boolean' }).notNull().default(false),
  tenantKey: text('tenant_key'),
  updatedAt: integer('updated_at').notNull(),
});

export const devicePairings = sqliteTable(
  'device_pairings',
  {
    id: text('id').primaryKey(),
    actorId: text('actor_id').notNull(),
    label: text('label').notNull(),
    platform: text('platform').notNull(),
    tokenHash: text('token_hash').notNull(),
    tokenHint: text('token_hint').notNull(),
    createdAt: integer('created_at').notNull(),
    lastUsedAt: integer('last_used_at'),
    revokedAt: integer('revoked_at'),
    expiresAt: integer('expires_at'),
  },
  (table) => [
    uniqueIndex('idx_device_pairings_token_hash').on(table.tokenHash),
    index('idx_device_pairings_actor').on(table.actorId, table.createdAt),
  ],
);
