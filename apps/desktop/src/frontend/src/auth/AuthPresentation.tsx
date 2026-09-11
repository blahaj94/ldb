import { ActionButton, ContentStack, ExampleSection, LayoutBlock, SupportingText } from '@ldb/ui'
import { useState } from 'react'
import type { AuthNotice, AuthPresentationProps } from './presentation'

const notices: Record<AuthNotice, string> = {
  LOGIN_CANCELLED: '로그인을 취소했습니다. 로그인 방법을 선택해 다시 시작할 수 있습니다.',
  LOGIN_EXPIRED: '로그인 대기 시간이 만료됐습니다. 새 로그인을 시작해 주세요.',
  LOGIN_RETURN_INVALID:
    '앱으로 돌아온 로그인 정보를 확인하지 못했습니다. 새 로그인은 현재 시도를 취소한 뒤 시작합니다.',
  LOGIN_RESTART_REQUIRED: '로그인을 완료하지 못했습니다. 새 로그인을 시작해 주세요.',
  BROWSER_OPEN_FAILED: '브라우저를 열지 못했습니다. 새 로그인을 시작해 주세요.',
  NETWORK_UNAVAILABLE: '네트워크 연결을 확인해 주세요.',
  AUTH_SERVICE_UNAVAILABLE: '인증 서비스에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.',
  RESTORE_RETRY_REQUIRED: '로그인 상태 확인을 마치지 못했습니다. 다시 시도해 주세요.',
  REAUTH_REQUIRED: '다시 로그인이 필요합니다.',
  SECURE_STORAGE_UNAVAILABLE:
    '이 기기의 안전한 저장소를 사용할 수 없습니다. 저장소를 확인한 뒤 다시 시도해 주세요.',
  TOKEN_SAVE_FAILED:
    '로그인 정보를 안전하게 저장하지 못했습니다. 저장소 복구 후 새 로그인이 필요합니다.',
  LOCAL_CLEAR_UNCONFIRMED:
    '이 기기의 로그인 정보 삭제를 확인하지 못했습니다. 서버 로그아웃도 확인하지 못했습니다. 재시작 후 안전한 차단을 보장할 수 없습니다.',
  LOGOUT_SERVER_UNCONFIRMED: '이 기기 정보는 지웠지만 서버 로그아웃은 확인하지 못했습니다.'
}

const providerLabels = { google: 'Google로 계속하기', discord: 'Discord로 계속하기' }

function SignedIn({
  snapshot,
  home,
  commandPending = false,
  onIntent
}: AuthPresentationProps): React.JSX.Element {
  const [welcomeDismissed, setWelcomeDismissed] = useState(false)
  const isWelcomeEntry = snapshot.entry === 'welcome'
  const shouldShowWelcome = isWelcomeEntry && !welcomeDismissed

  return (
    <ExampleSection title={shouldShowWelcome ? 'LDB에 오신 것을 환영합니다' : '내 계정'}>
      <SupportingText>{snapshot.user?.nickname}</SupportingText>
      {shouldShowWelcome ? (
        <>
          <SupportingText>준비가 끝났습니다. 시작하기를 눌러 홈으로 이동하세요.</SupportingText>
          <ActionButton
            type="button"
            disabled={commandPending}
            onClick={() => setWelcomeDismissed(true)}
          >
            시작하기
          </ActionButton>
        </>
      ) : (
        <>
          <ExampleSection title="화면 캡처">
            {home ?? <SupportingText>화면 캡처 기능은 준비 중입니다.</SupportingText>}
          </ExampleSection>
          <ActionButton
            type="button"
            disabled={commandPending}
            onClick={() => onIntent({ type: 'logout' })}
          >
            이 기기 로그아웃
          </ActionButton>
        </>
      )}
    </ExampleSection>
  )
}

function PhaseContent({
  snapshot,
  home,
  commandPending = false,
  onIntent
}: AuthPresentationProps): React.JSX.Element {
  const { phase, login } = snapshot
  const isSignedIn = phase === 'signedIn'
  const hasUser = snapshot.user != null
  const canShowAccount = isSignedIn && hasUser
  if (canShowAccount) {
    return (
      <SignedIn
        snapshot={snapshot}
        home={home}
        commandPending={commandPending}
        onIntent={onIntent}
      />
    )
  }

  const isSignedOut = phase === 'signedOut'
  if (isSignedOut) {
    const hasProviders = snapshot.providers.length > 0
    return (
      <ExampleSection title="LDB 로그인">
        <SupportingText>
          같은 이메일을 사용해도 로그인 방법이 다르면 별개의 계정입니다.
        </SupportingText>
        {!hasProviders && <SupportingText>사용 가능한 로그인 방법이 없습니다.</SupportingText>}
        {snapshot.providers.map((provider) => (
          <ActionButton
            key={provider}
            type="button"
            disabled={commandPending}
            onClick={() => onIntent({ type: 'beginLogin', provider })}
          >
            {providerLabels[provider]}
          </ActionButton>
        ))}
      </ExampleSection>
    )
  }

  const isStarting = phase === 'startingLogin'
  const isWaiting = phase === 'waitingBrowser'
  const isExchanging = phase === 'exchanging'
  const isLoginPending = isStarting || isWaiting || isExchanging
  const hasLogin = login != null
  const canCancelLogin = isLoginPending && hasLogin
  if (canCancelLogin) {
    const isReturnInvalid = snapshot.notice === 'LOGIN_RETURN_INVALID'
    const expiresAt = login.expiresAt
    const hasExpiry = expiresAt != null
    return (
      <ExampleSection title={isExchanging ? '로그인 처리 중' : '브라우저에서 로그인'}>
        <SupportingText>
          {isExchanging
            ? '브라우저에서 돌아온 로그인 정보를 확인하고 있습니다. 잠시 기다려 주세요.'
            : '브라우저에서 로그인을 계속해 주세요. 완료되면 앱으로 돌아옵니다.'}
        </SupportingText>
        {hasExpiry && (
          <SupportingText>
            로그인 대기 만료: <time dateTime={expiresAt}>{expiresAt}</time>
          </SupportingText>
        )}
        <SupportingText>
          앱에서 취소해도 브라우저를 닫거나 서버 처리를 되돌리지는 않습니다.
        </SupportingText>
        <ActionButton type="button" disabled loading>
          로그인 진행 중
        </ActionButton>
        <ActionButton
          type="button"
          disabled={commandPending}
          onClick={() => onIntent({ type: 'cancelLogin', attemptId: login.attemptId })}
        >
          로그인 취소
        </ActionButton>
        {isReturnInvalid && (
          <ActionButton
            type="button"
            disabled={commandPending}
            onClick={() => onIntent({ type: 'cancelLogin', attemptId: login.attemptId })}
          >
            새 로그인
          </ActionButton>
        )}
      </ExampleSection>
    )
  }

  const isRestorePaused = phase === 'restorePaused'
  const isStorageBlocked = phase === 'storageBlocked'
  const canRetry = isRestorePaused || isStorageBlocked
  if (canRetry) {
    return (
      <ExampleSection
        title={isStorageBlocked ? '저장소 확인이 필요합니다' : '계정을 복원하지 못했습니다'}
      >
        <SupportingText>
          {isStorageBlocked
            ? '안전한 저장과 삭제를 확인할 때까지 로그인을 사용할 수 없습니다.'
            : '연결을 확인하고 복원을 다시 시도하거나 이 기기에서 로그아웃하세요.'}
        </SupportingText>
        <ActionButton
          type="button"
          disabled={commandPending}
          onClick={() => onIntent({ type: 'retryAuth' })}
        >
          다시 시도
        </ActionButton>
        {isRestorePaused && (
          <ActionButton
            type="button"
            disabled={commandPending}
            onClick={() => onIntent({ type: 'logout' })}
          >
            이 기기 로그아웃
          </ActionButton>
        )}
      </ExampleSection>
    )
  }

  const isSigningOut = phase === 'signingOut'
  const title = isSigningOut ? '로그아웃 중' : '계정 복원 중'
  return (
    <ExampleSection title={title}>
      <SupportingText>완료될 때까지 잠시 기다려 주세요.</SupportingText>
      <ActionButton type="button" disabled loading>
        {title}
      </ActionButton>
    </ExampleSection>
  )
}

export function AuthPresentation(props: AuthPresentationProps): React.JSX.Element {
  const { notice } = props.snapshot
  const hasNotice = notice != null
  return (
    <LayoutBlock header="LDB" footer="LDB Desktop">
      <ContentStack>
        <PhaseContent {...props} />
        {hasNotice && (
          <div role="status">
            <SupportingText>{notices[notice]}</SupportingText>
          </div>
        )}
      </ContentStack>
    </LayoutBlock>
  )
}
