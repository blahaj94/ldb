import { Text, VStack } from '@seed-design/react'
import type { PropsWithChildren } from 'react'

// LDB composition: layout-01의 content 간격을 같은 역할의 모든 예제 영역에 적용한다.
export function ContentStack({ children }: PropsWithChildren) {
  return <VStack gap="x6">{children}</VStack>
}

export function ExampleSection({ title, children }: PropsWithChildren<{ title: string }>) {
  return (
    <VStack gap="x6" as="section">
      <Text as="h2" textStyle="t5Medium">{title}</Text>
      {children}
    </VStack>
  )
}

export function SupportingText({ children }: PropsWithChildren) {
  return <Text as="p" textStyle="t3Regular" color="fg.neutralSubtle">{children}</Text>
}
