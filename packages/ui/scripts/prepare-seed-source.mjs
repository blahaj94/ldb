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


  const isLayout = file.upstream.endsWith('/layout-01.tsx')
  if (isLayout) {
    const content = '<Text textStyle="t5Medium" color="fg.neutralSubtle">\n              Content\n            </Text>'
    const changes = [
      {
        before: 'export default function LayoutBlock() {',
        after: 'export interface LayoutBlockProps {\n  header?: string;\n  children?: React.ReactNode;\n  footer?: string;\n}\n\nexport default function LayoutBlock({ header = "Header", children = <Text textStyle="t5Medium" color="fg.neutralSubtle">Content</Text>, footer = "Footer" }: LayoutBlockProps) {'
      },
      { before: '>Header</Text>', after: '>{header}</Text>' },
      { before: content, after: '{children}' },
      { before: '              Footer\n', after: '              {footer}\n' }
    ]
    for (const change of changes) {
      const hasExpectedContent = localSource.includes(change.before)
      if (!hasExpectedContent) throw new Error('Pinned Layout content changed')
      localSource = localSource.replace(change.before, change.after)
      file.localChanges.push({
        reason: 'LDB composition: 공식 Layout 구조·Token·반응형 조건을 유지하며 중립 content slot만 연결한다.',
        ...change
      })
    }
  }

  const isModifiedSource = file.localChanges.length > 0
  if (isModifiedSource) {
    const summary = isDialog
      ? 'DialogTrigger의 동일 public type을 명시했습니다. Runtime 변경 없음.'
      : '공식 Layout 구조와 시각 값을 유지하며 header/footer/children content slot을 연결했습니다.'
    const notice = `/*! LDB 수정: ${summary} 상세: packages/ui/seed-provenance.json. */`
    const firstExport = localSource.indexOf('export ')
    const isExportMissing = firstExport < 0
    if (isExportMissing) throw new Error('Modified SEED source export is missing')
    localSource = localSource.slice(0, firstExport) + notice + '\n' + localSource.slice(firstExport)
    file.localChanges.push({ reason: 'Apache-2.0 §4(b) changed-file 고지', notice })
  }

  await writeFile(new URL(file.local, root), localSource)
  file.localSha256 = createHash('sha256').update(localSource).digest('hex')
}

await writeFile(manifestUrl, JSON.stringify(provenance, null, 2) + '\n')
