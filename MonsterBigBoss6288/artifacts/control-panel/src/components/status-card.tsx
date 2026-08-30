import React from 'react';
import { Activity, Power, Terminal } from 'lucide-react';
import { BotStatus } from '@workspace/api-client-react';

interface StatusCardProps {
  status: BotStatus | undefined;
  isLoading: boolean;
}

export function StatusCard({ status, isLoading }: StatusCardProps) {
  const isOnline = status?.loggedIn === true;
  
  const formatUptime = (seconds: number) => {
    if (!seconds) return '0 ثانية';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    
    const parts = [];
    if (h > 0) parts.push(`${h} ساعة`);
    if (m > 0) parts.push(`${m} دقيقة`);
    if (s > 0) parts.push(`${s} ثانية`);
    
    return parts.join(' و ');
  };

  return (
    <div className="relative overflow-hidden rounded-md border border-card-border bg-card p-5 shadow-lg">
      <div className="absolute top-0 right-0 h-1 w-full bg-gradient-to-r from-transparent via-primary/50 to-transparent opacity-50"></div>
      
      <div className="flex items-center justify-between mb-4 border-b border-border/50 pb-4">
        <div className="flex items-center gap-3">
          <div className="rounded-sm bg-primary/10 p-2 text-primary border border-primary/20">
            <Terminal size={20} />
          </div>
          <div>
            <h2 className="font-bold text-lg leading-none mb-1 text-foreground">نظام مستر</h2>
            <p className="text-xs text-muted-foreground font-mono">CORE_PROCESS_ID_884</p>
          </div>
        </div>
        
        <div className="flex items-center gap-2 bg-background/50 px-3 py-1.5 rounded-sm border border-border">
          {isLoading ? (
            <div className="h-2 w-2 rounded-full bg-muted animate-pulse"></div>
          ) : (
            <div 
              className={`h-2.5 w-2.5 rounded-full ${
                isOnline ? 'bg-status-online glow-online' : 'bg-status-offline flash-offline'
              }`}
            ></div>
          )}
          <span className={`text-xs font-bold tracking-wider ${
            isOnline ? 'text-status-online' : 'text-status-offline'
          }`}>
            {isLoading ? 'جاري الاتصال...' : (isOnline ? 'متصل' : 'غير متصل')}
          </span>
        </div>
      </div>
      
      <div className="grid grid-cols-2 gap-4">
        <div className="bg-background/40 p-3 rounded-sm border border-border/30">
          <p className="text-xs text-muted-foreground mb-1 uppercase tracking-wider">الحساب المتصل</p>
          <div className="font-medium truncate text-foreground text-sm">
            {isLoading ? (
              <span className="text-muted-foreground animate-pulse">يتم التحميل...</span>
            ) : status?.userName ? (
              <span className="font-bold">{status.userName}</span>
            ) : (
              <span className="text-muted-foreground">غير معروف</span>
            )}
          </div>
          <div className="text-[10px] text-muted-foreground font-mono mt-1 opacity-70">
            {status?.userID || 'NO_ID'}
          </div>
        </div>
        
        <div className="bg-background/40 p-3 rounded-sm border border-border/30">
          <p className="text-xs text-muted-foreground mb-1 uppercase tracking-wider flex items-center gap-1">
            <Activity size={12} />
            وقت التشغيل
          </p>
          <div className="font-mono text-sm text-foreground">
            {isLoading ? (
              <span className="text-muted-foreground animate-pulse">00:00:00</span>
            ) : (
              status?.uptime ? formatUptime(status.uptime) : '0 ثانية'
            )}
          </div>
          {status?.reconnectAttempts ? (
            <div className="text-[10px] text-status-offline font-mono mt-1">
              محاولات الاتصال: {status.reconnectAttempts}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
