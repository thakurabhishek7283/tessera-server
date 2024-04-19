# 5. Conversations are stored under an app-scoped key

Status: accepted

## Context

Clients identify a conversation by a short id such as `general`, and the id doubles as part of the
room name (`<appId>/chat:general`). Two apps served by one server can both have a `general`, so the
id alone cannot be the primary key.

## Decision

Store conversations under `<appId>/<id>` and expose only `<id>` on the wire. Direct conversations
use the id `dm:<hash>` where the hash is derived from the two sorted user ids, so both users compute
the same conversation without a lookup. Room conversations are created on the first message;
reading an unknown room conversation returns an empty history and creates nothing, so reads cannot
be used to fill the table.

## Consequences

- Every query that crosses the wire goes through two helpers (`conversationKey`, `wireConversationId`),
  and the authorizer applies the same key when it checks direct-message membership.
- Messages carry the app id as well, so a message id from another app is answered with `NOT_FOUND`.
- Ids that start with `dm:` can only come from `chat.open-direct`; sending to an invented one fails.
