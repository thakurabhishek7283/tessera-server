# 6. Uploads are validated by content, not by the declared type

Status: accepted

## Context

The multipart Content-Type is chosen by the client. Trusting it would allow HTML or script content
to be stored and served under an image type.

## Decision

Read the file, detect its type from the leading bytes (`file-type`), and refuse anything that cannot
be identified. If the client declared a specific type that disagrees with the content, the upload is
rejected; a generic `application/octet-stream` is accepted. The allowlist is matched against the
detected type, image dimensions come from `image-size`, and the stored name is `<ulid>.<detected
extension>`. Files are served with `nosniff`, long-lived caching, and non-images as attachments.

## Consequences

- Text-based formats (SVG, plain text, HTML) cannot be uploaded; that is intentional for a public
  upload endpoint, and `UPLOAD_ALLOWED` cannot widen it to types that have no signature.
- Files are held in memory up to `UPLOAD_MAX_BYTES` (5 MB by default) while being checked.
