## "But can't I just use GitLens Search & Compare?"

**Short answer:** Yes, sort of.

## Key Differences

### 🔄 Live Updates
- **Fresh File Explorer**: Automatically refreshes on every Git operation (commit, checkout, pull, etc.) or file change
- **GitLens**: Manual refresh

### 📅 Time-Based View
- **Fresh File Explorer**: Built-in time windows (x days, or pending changes only)
- **GitLens**: Reference-based only (branches, tags, commits) - no "show me files from last 2 weeks" option. You'd have to look up that 2 week old commit's hash first to use it as a target for your comparison.

> I'm not trying to claim that a time-based view is better than a commit centric one. But it can be preferable to some (or sometimes). Your brain doesn't have git installed, but usually knows what day it is.

### 🗂️ Multi-Repository Support
- **Fresh File Explorer**: Automatic unified view across all workspace repositories
- **GitLens**: Must manually create separate comparisons for each repository

### 🎯 Better UX for Daily Workflow
- **Fresh File Explorer**: 
  - File counts on directories
  - Temporal context ("modified • just now")
  - One view, zero configuration
  - Deleted files prominently shown with restore actions
  
- **GitLens**:
  - Commit-centric view
  - Requires understanding of Git references
  - Must create and manage comparisons
  - Less discoverable


Fresh File Explorer is designed for what you need 80% of the time. GitLens is for the other 20%.

| Feature                     |    Fresh File Explorer | GitLens                       |
| --------------------------- | ---------------------: | :---------------------------- |
| **Focus**                   | Recent file navigation | Comprehensive git integration |
| **Learning Curve**          |                Minimal | Significant                   |
| **File Tree View**          |      ✅ Primary feature | ✅ Available                   |
| **Blame/Annotations**       |                      ❌ | ✅ Excellent                   |
| **Commit Graph**            |                      ❌ | ✅ Visual graph                |
| **Line History**            |                      ❌ | ✅ Detailed                    |
| **Deleted File Restore**    |            ✅ One-click | ✅ Via commits                 |
| **Author/Commit Filtering** |  ✅ Visual multi-select | ✅ Via search                  |
| **Price**                   |                 ✅  Free, but I will always accept your money | ❌ Free, but they will sometimes demand your money |
