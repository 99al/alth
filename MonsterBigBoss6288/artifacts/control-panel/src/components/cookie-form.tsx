import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { useUpdateBotCookies, getGetBotStatusQueryKey } from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { Fingerprint, RefreshCcw, AlertTriangle } from 'lucide-react';

export function CookieForm() {
  const [cookieData, setCookieData] = useState('');
  const [isParsing, setIsParsing] = useState(false);
  const { toast } = useToast();
  const updateCookies = useUpdateBotCookies();
  const queryClient = useQueryClient();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!cookieData.trim()) return;

    setIsParsing(true);
    try {
      // Basic validation to check if it's valid JSON and an array
      const parsed = JSON.parse(cookieData);
      
      if (!Array.isArray(parsed)) {
        throw new Error("الكوكيز يجب أن تكون مصفوفة JSON (Array)");
      }

      updateCookies.mutate(
        { data: { cookies: parsed } },
        {
          onSuccess: (res) => {
            setCookieData('');
            toast({
              title: "تم بنجاح",
              description: res.message || "تم تحديث الكوكيز وجاري إعادة الاتصال",
              variant: "default",
              className: "border-status-online bg-status-online/10 text-status-online",
            });
            // Force status refresh immediately
            queryClient.invalidateQueries({ queryKey: getGetBotStatusQueryKey() });
          },
          onError: (err: any) => {
            const msg = err?.data?.error || err?.message || "حدث خطأ أثناء تحديث الكوكيز";
            toast({
              title: "فشل التحديث",
              description: msg,
              variant: "destructive",
            });
          },
          onSettled: () => {
            setIsParsing(false);
          }
        }
      );
    } catch (err: any) {
      setIsParsing(false);
      toast({
        title: "خطأ في التنسيق",
        description: "يرجى التأكد من أن النص المدخل هو JSON صالح.",
        variant: "destructive",
      });
    }
  };

  const isPending = isParsing || updateCookies.isPending;

  return (
    <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-3">
      <div className="flex items-center gap-2 mb-1">
        <Fingerprint size={16} className="text-primary" />
        <h3 className="text-sm font-bold text-foreground">حقن بيانات الجلسة (Cookies)</h3>
      </div>
      
      <div className="relative group">
        <div className="absolute -inset-0.5 bg-primary/20 blur opacity-30 group-focus-within:opacity-100 transition duration-500 rounded-md"></div>
        <Textarea
          placeholder="قم بلصق مصفوفة الكوكيز (JSON Array) هنا..."
          value={cookieData}
          onChange={(e) => setCookieData(e.target.value)}
          className="min-h-[120px] resize-none font-mono text-xs bg-background/80 border-border focus:border-primary text-foreground placeholder:text-muted-foreground relative z-10 p-3 leading-relaxed"
          dir="ltr"
        />
      </div>
      
      <div className="flex items-start gap-2 text-xs text-muted-foreground bg-background/50 p-2 rounded-sm border border-border/50">
        <AlertTriangle size={14} className="text-status-offline shrink-0 mt-0.5" />
        <p>تنبيه: حقن الكوكيز سيقوم بإعادة تشغيل جلسة البوت. تأكد من صحة البيانات لتجنب الحظر.</p>
      </div>

      <Button 
        type="submit" 
        disabled={!cookieData.trim() || isPending}
        className="w-full bg-primary hover:bg-primary/90 text-primary-foreground font-bold shadow-[0_0_15px_rgba(255,0,0,0.3)] transition-all active:scale-[0.98]"
      >
        {isPending ? (
          <>
            <RefreshCcw size={16} className="ml-2 animate-spin" />
            جاري المعالجة...
          </>
        ) : (
          "تحديث الكوكيز وإعادة الاتصال"
        )}
      </Button>
    </form>
  );
}
