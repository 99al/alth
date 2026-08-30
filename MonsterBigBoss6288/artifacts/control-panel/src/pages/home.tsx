import React from 'react';
import { useGetBotStatus, getGetBotStatusQueryKey } from '@workspace/api-client-react';
import { StatusCard } from '@/components/status-card';
import { CookieForm } from '@/components/cookie-form';
import { CommandsList } from '@/components/commands-list';
import { AdminsList } from '@/components/admins-list';

export default function Home() {
  // Auto-refresh status every 5 seconds
  const { data: status, isLoading } = useGetBotStatus({
    query: {
      refetchInterval: 5000,
      queryKey: getGetBotStatusQueryKey()
    }
  });

  return (
    <div className="min-h-[100dvh] w-full bg-background flex flex-col items-center">
      {/* Container restricted to mobile width (max-width: 480px) and centered */}
      <div className="w-full max-w-[480px] min-h-screen flex flex-col px-4 py-6 relative">
        
        {/* Ambient background glow */}
        <div className="fixed top-[-10%] left-[-10%] w-[50%] h-[30%] bg-primary/5 blur-[120px] rounded-full pointer-events-none"></div>
        <div className="fixed bottom-[10%] right-[-10%] w-[40%] h-[40%] bg-primary/5 blur-[100px] rounded-full pointer-events-none"></div>

        {/* Section 1: Bot Status & Login */}
        <div className="mb-6 z-10 relative">
          <StatusCard status={status} isLoading={isLoading} />
          <CookieForm />
        </div>

        {/* Decorative Divider */}
        <div className="w-full h-px bg-gradient-to-r from-transparent via-border to-transparent my-2 opacity-50 z-10 relative"></div>

        {/* Section 2: Commands Control */}
        <div className="flex-1 z-10 relative">
          <CommandsList />
        </div>

        {/* Decorative Divider */}
        <div className="w-full h-px bg-gradient-to-r from-transparent via-border to-transparent my-6 opacity-50 z-10 relative"></div>

        {/* Section 3: Admins Management */}
        <div className="z-10 relative pb-10">
          <AdminsList />
        </div>
        
        {/* Footer */}
        <div className="mt-auto pt-6 pb-2 text-center text-[10px] font-mono text-muted-foreground/50 z-10 relative">
          SYSTEM.CTRL // V_1.0.0 // MISTER_BOT
        </div>
      </div>
    </div>
  );
}
