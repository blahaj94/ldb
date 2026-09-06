import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'

const root = new URL('../', import.meta.url)
const manifestUrl = new URL('seed-provenance.json', root)
const provenance = JSON.parse(await readFile(manifestUrl, 'utf8'))
const triggerExport = 'export const DialogTrigger = ContentDialog.Trigger;'
const portableTriggerExport = 'export const DialogTrigger: React.ForwardRefExoticComponent<DialogTriggerProps & React.RefAttributes<HTMLButtonElement>> = ContentDialog.Trigger;'

for (const file of provenance.files) {
  const url = `https://raw.githubusercontent.com/daangn/seed-design/${provenance.commit}/${file.upstream}`
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Pinned SEED source fetch failed: ${response.status}`)
  const upstream = await response.text()
  const sourceHash = createHash('sha256').update(upstream).digest('hex')
  const hasExpectedSource = sourceHash === file.sha256
  if (!hasExpectedSource) throw new Error(`Pinned SEED source checksum mismatch: ${file.upstream}`)

  const isDialog = file.upstream.endsWith('/dialog.tsx')
  let localSource = upstream
  file.localChanges = []
  if (isDialog) {
    const hasExpectedExport = upstream.includes(triggerExport)
    if (!hasExpectedExport) throw new Error('Pinned DialogTrigger export changed')
    localSource = upstream.replace(triggerExport, portableTriggerExport)
    file.localChanges.push({
      reason: 'Declaration이 pnpm의 private transitive 경로를 참조하지 않도록 공식 export type을 명시한다. Runtime 변경 없음.',
      before: triggerExport,
      after: portableTriggerExport
    })
  }

  await writeFile(new URL(file.local, root), localSource)
  file.localSha256 = createHash('sha256').update(localSource).digest('hex')
}

await writeFile(manifestUrl, JSON.stringify(provenance, null, 2) + '\n')
