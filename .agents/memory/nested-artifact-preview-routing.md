---
name: Nested artifact preview routing
description: Environment-specific behavior when an imported project lives below the workspace root alongside older artifact registrations.
---

When an imported project is kept in a nested directory while older artifacts remain at the workspace root, the default preview may resolve to a legacy service or a 404 even though the active nested web service is healthy on its configured local port.

**Why:** Artifact discovery can expose duplicate directory names or artifact IDs, while the default preview still follows the root port mapping. This makes a healthy app look broken and can also cause old services to compete for ports.

**How to apply:** Verify the active service directly on its configured local port and inspect registered artifacts before changing application code. Consolidate or explicitly route duplicate artifacts as a separate cleanup task.