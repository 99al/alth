import React, { useState } from 'react';
import { 
  useGetBotAdmins, 
  useAddBotAdmin, 
  useRemoveBotAdmin, 
  getGetBotAdminsQueryKey 
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { ShieldCheck, Trash2, Plus, X } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export function AdminsList() {
  const { data, isLoading } = useGetBotAdmins({ 
    query: { queryKey: getGetBotAdminsQueryKey() } 
  });
  
  const admins = data?.admins || [];
  
  const addAdmin = useAddBotAdmin();
  const removeAdmin = useRemoveBotAdmin();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  
  const [newAdminId, setNewAdminId] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const handleAddAdmin = (e: React.FormEvent) => {
    e.preventDefault();
    const cleanId = newAdminId.trim();
    if (!cleanId || !/^\d+$/.test(cleanId)) {
      toast({
        title: "معرف غير صالح",
        description: "يجب أن يحتوي معرف فيسبوك على أرقام فقط",
        variant: "destructive",
      });
      return;
    }

    addAdmin.mutate(
      { data: { id: cleanId } },
      {
        onSuccess: () => {
          setNewAdminId('');
          queryClient.invalidateQueries({ queryKey: getGetBotAdminsQueryKey() });
          toast({
            title: "تم الإضافة",
            description: "تم إضافة المشرف بنجاح",
            className: "border-status-online text-status-online bg-status-online/10",
          });
        },
        onError: (err: any) => {
          toast({
            title: "خطأ",
            description: err.error?.error || "فشل في إضافة المشرف",
            variant: "destructive",
          });
        }
      }
    );
  };

  const handleDeleteAdmin = (id: string) => {
    removeAdmin.mutate(
      { id },
      {
        onSuccess: () => {
          setConfirmDeleteId(null);
          queryClient.invalidateQueries({ queryKey: getGetBotAdminsQueryKey() });
          toast({
            title: "تم الحذف",
            description: "تم إزالة المشرف بنجاح",
            className: "border-muted text-muted-foreground bg-muted/10",
          });
        },
        onError: (err: any) => {
          toast({
            title: "خطأ",
            description: err.error?.error || "فشل في إزالة المشرف",
            variant: "destructive",
          });
        }
      }
    );
  };

  return (
    <div className="mt-8 flex flex-col gap-4">
      <div className="flex items-center justify-between border-b border-border pb-2">
        <div className="flex items-center gap-2 text-foreground">
          <ShieldCheck size={18} className="text-primary" />
          <h3 className="font-bold">المشرفون</h3>
        </div>
        <div className="text-xs text-muted-foreground bg-muted/20 px-2 py-1 rounded-full font-mono">
          {admins?.length || 0} ADMINS
        </div>
      </div>

      <div className="flex flex-col gap-2 max-h-[35vh] overflow-y-auto pr-1 custom-scrollbar">
        {isLoading ? (
          Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="bg-card border border-card-border rounded-sm p-3 flex items-center justify-between animate-pulse">
              <div className="flex items-center gap-3">
                <div className="w-1.5 h-1.5 rounded-full bg-muted"></div>
                <div className="h-4 w-28 bg-muted rounded"></div>
              </div>
              <div className="h-8 w-8 bg-muted rounded-sm"></div>
            </div>
          ))
        ) : admins?.length === 0 ? (
          <div className="text-center py-6 text-muted-foreground text-sm bg-card rounded-sm border border-border border-dashed">
            لا يوجد مشرفين مسجلين
          </div>
        ) : (
          admins?.map((admin: any) => {
            const id = typeof admin === 'string' ? admin : admin.id;
            const isConfirming = confirmDeleteId === id;

            return (
              <div 
                key={id}
                className="bg-card border border-border rounded-sm p-3 flex items-center justify-between transition-colors hover:border-primary/30 group"
              >
                <div className="flex items-center gap-3">
                  <div className="w-1.5 h-1.5 rounded-full bg-primary opacity-50 group-hover:opacity-100 transition-opacity"></div>
                  <span className="font-mono text-sm text-foreground">{id}</span>
                </div>
                
                {isConfirming ? (
                  <div className="flex items-center gap-2">
                    <Button 
                      size="sm" 
                      variant="destructive" 
                      onClick={() => handleDeleteAdmin(id)}
                      disabled={removeAdmin.isPending}
                      className="h-8 px-3 text-xs font-bold"
                    >
                      {removeAdmin.isPending ? "جاري..." : "تأكيد الحذف"}
                    </Button>
                    <Button 
                      size="icon" 
                      variant="ghost" 
                      onClick={() => setConfirmDeleteId(null)}
                      className="h-8 w-8 text-muted-foreground hover:text-foreground"
                    >
                      <X size={14} />
                    </Button>
                  </div>
                ) : (
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => setConfirmDeleteId(id)}
                    className="h-8 w-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                  >
                    <Trash2 size={16} />
                  </Button>
                )}
              </div>
            );
          })
        )}
      </div>

      <form onSubmit={handleAddAdmin} className="mt-2 flex gap-2">
        <div className="relative flex-1">
          <Input 
            type="text" 
            inputMode="numeric"
            placeholder="معرف فيسبوك (رقم)..."
            value={newAdminId}
            onChange={(e) => setNewAdminId(e.target.value.replace(/\D/g, ''))}
            className="w-full bg-background border-border focus:border-primary focus-visible:ring-1 focus-visible:ring-primary font-mono text-sm h-10 px-3 transition-colors"
            dir="ltr"
          />
        </div>
        <Button 
          type="submit" 
          disabled={!newAdminId.trim() || addAdmin.isPending}
          className="shrink-0 h-10 px-4 bg-primary hover:bg-primary/90 text-primary-foreground font-bold shadow-[0_0_10px_rgba(255,0,0,0.2)] transition-all active:scale-95"
        >
          {addAdmin.isPending ? "جاري..." : (
            <>
              <Plus size={16} className="ml-1" />
              إضافة مشرف
            </>
          )}
        </Button>
      </form>
    </div>
  );
}
