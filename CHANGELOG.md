# Changelog

## 0.1.0

- First release. Opens Avro container files, Arrow IPC files and streams, and Feather V2 files (LZ4 and ZSTD) as a paged table.
- Schema tab with types, nullability, compression or codec, batches and file metadata.
- Column stats on demand, search with Cancel, and export of a page or all rows to CSV or JSON.
- Files over 4 GB, Feather V1 files and unsupported Avro codecs get a clear message.
- One-time rating prompt that you can turn off with `arrowAvroViewer.askForRating`.
