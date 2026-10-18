'use client';

import { TerminalApp } from '@/components/terminal-app';
import { LoginGate } from '@/components/auth/login-gate';

export default function Home() {
  return (
    <LoginGate>
      <TerminalApp />
    </LoginGate>
  );
}
