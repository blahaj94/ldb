import type { ReactNode } from 'react'
import { ContentStack, ExampleSection, LayoutBlock, SupportingText } from '@ldb/ui'
import type { AuthApi } from '../../../preload/common/types/auth'
import { AuthPresentation } from './AuthPresentation'
import { useAuthBridge } from './useAuthBridge'

export function AuthBridge({ api, home }: { api: AuthApi; home?: ReactNode }): React.JSX.Element {
  const { snapshot, presentationEpoch, commandPending, connectionFailed, onIntent } =
    useAuthBridge(api)
  const hasSnapshot = snapshot != null
  if (hasSnapshot) {
    return (
      <AuthPresentation
        key={presentationEpoch}
        snapshot={snapshot}
        home={home}
        commandPending={commandPending}
        onIntent={onIntent}
      />
    )
  }
  return (
    <LayoutBlock header="LDB" footer="LDB Desktop">
      <ContentStack>
        <ExampleSection title="LDB 로그인">
          <SupportingText>
            {connectionFailed
              ? '인증 연결을 확인할 수 없습니다. 앱 화면을 다시 열어 주세요.'
              : '인증 상태를 확인하고 있습니다.'}
          </SupportingText>
        </ExampleSection>
      </ContentStack>
    </LayoutBlock>
  )
}
