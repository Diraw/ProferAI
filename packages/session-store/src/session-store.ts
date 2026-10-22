import type { SessionStore, SessionStorePaths } from './contracts'
import { createSessionFileStore } from './file-store'
import { createSessionIndexStore } from './index-store'
import { createSessionMessageStore } from './message-store'
import { createSessionMetadataStore } from './metadata-store'

export function createSessionStore(paths: SessionStorePaths): SessionStore {
  const index = createSessionIndexStore(paths)
  return {
    paths,
    index,
    metadata: createSessionMetadataStore({ index }),
    messages: createSessionMessageStore(paths),
    files: createSessionFileStore(paths),
  }
}
