import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import '@seed-design/css/base.css'
import '@ldb/ui/foundation.css'
import {
  ActionButton,
  ContentStack,
  DialogAction,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogRoot,
  DialogTrigger,
  ExampleSection,
  LayoutBlock,
  SupportingText,
  TextField,
  TextFieldInput
} from '@ldb/ui'

function Examples() {
  const [name, setName] = useState('예시 이름')
  const [activation, setActivation] = useState('아직 실행하지 않았습니다.')

  return (
    <LayoutBlock header="공용 UI Example" footer="SEED Design · 고정 source와 같은 공용 자산">
      <ContentStack>
        <SupportingText>
          Component · Pattern · Template — 중립 content로 공식 Variant와 State를 확인합니다.
          Layout은 layout-01의 content slot을 연결한 LDB composition입니다.
        </SupportingText>
        <ExampleSection title="Action Button · Variant와 State">
          <ActionButton onClick={() => setActivation('기본 버튼 실행')}>
            Brand solid · 기본
          </ActionButton>
          <ActionButton variant="neutralSolid" onClick={() => setActivation('Neutral solid 실행')}>
            Neutral solid
          </ActionButton>
          <ActionButton variant="neutralWeak" onClick={() => setActivation('Neutral weak 실행')}>
            Neutral weak
          </ActionButton>
          <ActionButton
            variant="criticalSolid"
            onClick={() => setActivation('Critical solid 실행')}
          >
            Critical solid
          </ActionButton>
          <ActionButton
            variant="neutralOutline"
            onClick={() => setActivation('Neutral outline 실행')}
          >
            Neutral outline
          </ActionButton>
          <ActionButton variant="ghost" onClick={() => setActivation('Ghost 실행')}>
            Ghost
          </ActionButton>
          <ActionButton disabled onClick={() => setActivation('Disabled callback')}>
            Disabled · 실행 차단
          </ActionButton>
          <ActionButton loading onClick={() => setActivation('Loading-only 실행')}>
            Loading-only · 실행 허용
          </ActionButton>
          <ActionButton loading disabled onClick={() => setActivation('Busy callback')}>
            Busy · loading + disabled
          </ActionButton>
          <SupportingText>
            <output aria-live="polite">{activation}</output>
          </SupportingText>
          <SupportingText>
            공식 loading은 disabled를 포함하지 않습니다. Busy 작업의 차단은 두 prop을 함께
            사용합니다.
          </SupportingText>
        </ExampleSection>
        <ExampleSection title="Text Field Input · label, value, invalid">
          <TextField
            label="표시 이름"
            description="도메인과 관계없는 예시 이름입니다."
            value={name}
            onValueChange={({ value }) => setName(value)}
          >
            <TextFieldInput />
          </TextField>
          <TextField
            label="Invalid 예시"
            invalid
            errorMessage="이름을 입력해주세요."
            description="오류와 설명의 연결을 확인합니다."
          >
            <TextFieldInput />
          </TextField>
          <TextField label="Disabled 예시" disabled value="변경할 수 없습니다.">
            <TextFieldInput />
          </TextField>
          <TextField label="Read-only 예시" readOnly value="선택하고 읽을 수 있습니다.">
            <TextFieldInput />
          </TextField>
        </ExampleSection>
        <ExampleSection title="Pattern · 입력한 값 확인">
          <SupportingText>
            Text Field와 Dialog를 조합한 LDB composition입니다. 제출·저장 동작은 없습니다.
          </SupportingText>
          <DialogRoot>
            <DialogTrigger asChild>
              <ActionButton variant="neutralOutline">Dialog 열기</ActionButton>
            </DialogTrigger>
            <DialogContent title="입력한 값" description="열기·닫기·keyboard focus를 확인합니다.">
              <DialogBody>
                <SupportingText>{name}</SupportingText>
              </DialogBody>
              <DialogFooter>
                <DialogAction>확인</DialogAction>
              </DialogFooter>
            </DialogContent>
          </DialogRoot>
          <SupportingText>
            Escape 또는 닫기로 종료하면 열기 버튼으로 focus가 돌아옵니다.
          </SupportingText>
        </ExampleSection>
      </ContentStack>
    </LayoutBlock>
  )
}

const root = document.getElementById('root')
const isRootMissing = root == null
if (isRootMissing) {
  throw new Error('Example root is missing')
}
createRoot(root).render(
  <StrictMode>
    <Examples />
  </StrictMode>
)
