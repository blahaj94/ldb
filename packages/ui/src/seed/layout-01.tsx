"use client";

import { Box, Layout, Text, VStack } from "@seed-design/react";

export interface LayoutBlockProps {
  header?: string;
  children?: React.ReactNode;
  footer?: string;
}

export default function LayoutBlock({ header = "Header", children = <Text textStyle="t5Medium" color="fg.neutralSubtle">Content</Text>, footer = "Footer" }: LayoutBlockProps) {
  return (
    <Layout.Root>
      <Layout.Content>
        <VStack gap="x6" paddingY="x6">
          <Box
            as="header"
            bg="bg.neutralWeak"
            borderRadius="r2"
            paddingX="x6"
            paddingY="x4"
            display="flex"
            alignItems="center"
          >
            <Text textStyle="t6Bold">{header}</Text>
          </Box>

          <Box
            as="main"
            bg="bg.neutralWeak"
            borderRadius="r2"
            paddingX="x6"
            paddingY="x10"
            display="flex"
            alignItems="center"
            justifyContent="center"
            minHeight="200px"
          >
            {children}
          </Box>

          <Box
            as="footer"
            bg="bg.neutralWeak"
            borderRadius="r2"
            paddingX="x6"
            paddingY="x4"
            display="flex"
            alignItems="center"
          >
            <Text textStyle="t3Regular" color="fg.neutralSubtle">
              {footer}
            </Text>
          </Box>
        </VStack>
      </Layout.Content>
    </Layout.Root>
  );
}
