import React from 'react';
import { useGetBotCommands, useToggleBotCommand, getGetBotCommandsQueryKey } from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Cpu, Power, Search } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';

export function CommandsList() {
  const { data: commands, isLoading } = useGetBotCommands({ 
    query: { queryKey: getGetBotCommandsQueryKey() } 
  });
  
  const toggleCommand = useToggleBotCommand();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [searchTerm, setSearchTerm] = React.useState('');

  const handleToggle = (name: string, currentState: boolean) => {
    // Optimistically update the UI if we want, or just rely on react-query invalidation
    // For simplicity, let's just trigger and let react-query refetch
    toggleCommand.mutate(
      { name },
      {
        onSuccess: (updatedCmd) => {
          // Invalidate to fetch fresh list, or we could setQueryData locally
          queryClient.invalidateQueries({ queryKey: getGetBotCommandsQueryKey() });
          
          toast({
            title: "تحديث الأمر",
            description: `تم ${updatedCmd.enabled ? 'تفعيل' : 'إيقاف'} أمر "${name}" بنجاح`,
            className: updatedCmd.enabled 
              ? "border-status-online text-status-online bg-status-online/10" 
              : "border-muted text-muted-foreground bg-muted/10",
          });
        },
        onError: (err) => {
          toast({
            title: "خطأ",
            description: "فشل في تحديث حالة الأمر",
            variant: "destructive",
          });
        }
      }
    );
  };

  const filteredCommands = commands?.filter(cmd => 
    cmd.name.toLowerCase().includes(searchTerm.toLowerCase()) || 
    cmd.description.toLowerCase().includes(searchTerm.toLowerCase())
  );

  return (
    <div className="mt-8 flex flex-col gap-4">
      <div className="flex items-center justify-between border-b border-border pb-2">
        <div className="flex items-center gap-2 text-foreground">
          <Cpu size={18} className="text-primary" />
          <h3 className="font-bold">وحدات التحكم (الأوامر)</h3>
        </div>
        <div className="text-xs text-muted-foreground bg-muted/20 px-2 py-1 rounded-full font-mono">
          {commands?.length || 0} MODULES
        </div>
      </div>

      <div className="relative">
        <Search className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground" size={14} />
        <input 
          type="text" 
          placeholder="بحث في الأوامر..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="w-full bg-background border border-border rounded-sm py-2 pr-9 pl-3 text-sm focus:outline-none focus:border-primary transition-colors text-foreground placeholder:text-muted-foreground"
        />
      </div>

      <div className="flex flex-col gap-2 max-h-[60vh] overflow-y-auto pr-1 custom-scrollbar">
        {isLoading ? (
          Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="bg-card border border-card-border rounded-sm p-3 flex items-center justify-between animate-pulse">
              <div className="flex-1">
                <div className="h-4 w-24 bg-muted rounded mb-2"></div>
                <div className="h-3 w-48 bg-muted rounded"></div>
              </div>
              <div className="h-5 w-10 bg-muted rounded-full"></div>
            </div>
          ))
        ) : filteredCommands?.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground text-sm bg-card rounded-sm border border-border border-dashed">
            لا توجد أوامر مطابقة للبحث
          </div>
        ) : (
          filteredCommands?.map((cmd) => (
            <div 
              key={cmd.name}
              className={`bg-card border rounded-sm p-3 flex flex-row items-center justify-between transition-all duration-300 ${
                cmd.enabled 
                  ? 'border-primary/30 shadow-[0_0_10px_rgba(255,0,0,0.05)]' 
                  : 'border-border opacity-70 grayscale-[0.5]'
              }`}
            >
              <div className="flex flex-col flex-1 pl-4">
                <Label 
                  htmlFor={`cmd-toggle-${cmd.name}`}
                  className="font-bold text-foreground text-sm cursor-pointer mb-1 flex items-center gap-2"
                >
                  <span className={`inline-block w-1.5 h-1.5 rounded-full ${cmd.enabled ? 'bg-primary' : 'bg-muted-foreground'}`}></span>
                  {cmd.name}
                </Label>
                <p className="text-xs text-muted-foreground leading-tight">
                  {cmd.description || 'لا يوجد وصف متاح'}
                </p>
              </div>
              
              <Switch
                id={`cmd-toggle-${cmd.name}`}
                checked={cmd.enabled}
                onCheckedChange={(checked) => handleToggle(cmd.name, checked)}
                disabled={toggleCommand.isPending}
                className="data-[state=checked]:bg-primary shrink-0"
              />
            </div>
          ))
        )}
      </div>

      <style dangerouslySetInnerHTML={{__html: `
        .custom-scrollbar::-webkit-scrollbar {
          width: 4px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: rgba(0,0,0,0.2);
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: hsl(var(--primary) / 0.5);
          border-radius: 4px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: hsl(var(--primary));
        }
      `}} />
    </div>
  );
}
