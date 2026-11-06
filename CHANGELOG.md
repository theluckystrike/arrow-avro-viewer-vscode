# Changelog

## 0.1.1 (2026-11-06)

- The status line at the bottom of the viewer has two small links, "Sponsor" (GitHub Sponsors) and "More free viewers". The new setting `arrowAvroViewer.showSupportLinks` (default `true`) hides them, and so does the "Hide" link next to them. There is no popup, and nothing is sent anywhere.
- New commands "Avro and Arrow Viewer: Support the developer" and "Avro and Arrow Viewer: More free viewers". The second one lists the other Zovo extensions and installs only the one you pick. Ones that are not on the Marketplace yet open their GitHub page.
- The listing gets a Sponsor button. The README has a short Support section and lists all Zovo extensions.

## 0.1.0

- First release. Opens Avro container files, Arrow IPC files and streams, and Feather V2 files (LZ4 and ZSTD) as a paged table.
- Schema tab with types, nullability, compression or codec, batches and file metadata.
- Column stats on demand, search with Cancel, and export of a page or all rows to CSV or JSON.
- Files over 4 GB, Feather V1 files and unsupported Avro codecs get a clear message.
- One-time rating prompt that you can turn off with `arrowAvroViewer.askForRating`.
