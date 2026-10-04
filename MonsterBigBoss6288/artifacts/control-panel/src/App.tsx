import './same-origin-fetch.js';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import Home from '@/pages/home';
import { Route, Switch, Router as WouterRouter } from 'wouter';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: true,
    },
  },
});

type GateState = 'loading' | 'login' | 'authenticated' | 'unconfigured' | 'unavailable';

function DashboardAuthGate({ children }: { children: ReactNode }) {
  const queryCache = useQueryClient();
  const [state, setState] = useState<GateState>('loading');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    fetch('/api/auth/session', { credentials: 'same-origin', cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error('session-check-failed');
        return response.json();
      })
      .then((result) => {
        if (!active) return;
        setState(!result.configured ? 'unconfigured' : result.authenticated ? 'authenticated' : 'login');
      })
      .catch(() => {
        if (active) setState('unavailable');
      });
    return () => { active = false; };
  }, []);

  const handleLogin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!password || busy) return;

    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (response.status === 429) {
        setPassword('');
        setError('محاولات دخول كثيرة؛ انتظر قليلاً ثم أعد المحاولة.');
        return;
      }
      if (!response.ok) {
        setPassword('');
        setError(response.status === 503 ? 'المصادقة غير مهيأة على الخادم.' : 'كلمة المرور غير صحيحة.');
        return;
      }
      setPassword('');
      queryCache.clear();
      setState('authenticated');
    } catch {
      setPassword('');
      setError('تعذر الاتصال بالخادم؛ حاول مرة أخرى.');
    } finally {
      setBusy(false);
    }
  };

  const handleLogout = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
      });
      if (!response.ok) throw new Error('logout-failed');
      queryCache.clear();
      setPassword('');
      setState('login');
    } catch {
      setError('تعذر إنهاء الجلسة؛ أعد المحاولة.');
    } finally {
      setBusy(false);
    }
  };

  if (state === 'loading') {
    return <div className="min-h-screen grid place-items-center bg-background text-muted-foreground">جارٍ التحقق من الجلسة...</div>;
  }

  if (state === 'unconfigured') {
    return <div className="min-h-screen grid place-items-center bg-background p-4" dir="rtl"><div className="w-full max-w-sm rounded-md border border-border bg-card p-6 text-center"><h1 className="mb-3 text-lg font-bold text-foreground">لوحة التحكم غير مهيأة</h1><p className="text-sm text-muted-foreground">يلزم ضبط متغيرات المصادقة السرية على الخادم قبل إتاحة اللوحة.</p></div></div>;
  }

  if (state === 'unavailable') {
    return <div className="min-h-screen grid place-items-center bg-background p-4" dir="rtl"><div className="w-full max-w-sm rounded-md border border-border bg-card p-6 text-center"><h1 className="mb-3 text-lg font-bold text-foreground">تعذر الوصول إلى الخادم</h1><Button type="button" onClick={() => window.location.reload()}>إعادة المحاولة</Button></div></div>;
  }

  if (state === 'login') {
    return (
      <div className="min-h-screen grid place-items-center bg-background p-4" dir="rtl">
        <form onSubmit={handleLogin} className="w-full max-w-sm rounded-md border border-border bg-card p-6 shadow-lg">
          <h1 className="mb-2 text-xl font-bold text-foreground">تسجيل الدخول</h1>
          <p className="mb-5 text-sm text-muted-foreground">أدخل كلمة مرور لوحة التحكم للمتابعة.</p>
          <label htmlFor="dashboard-password" className="mb-2 block text-sm font-medium text-foreground">كلمة المرور</label>
          <Input
            id="dashboard-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
            maxLength={512}
            className="mb-3 bg-background"
            dir="ltr"
          />
          {error && <p role="alert" className="mb-3 text-sm text-destructive">{error}</p>}
          <Button type="submit" disabled={!password || busy} className="w-full">
            {busy ? 'جارٍ التحقق...' : 'دخول'}
          </Button>
        </form>
      </div>
    );
  }

  return (
    <>
      <div className="mx-auto flex w-full max-w-[480px] justify-end px-4 pt-3" dir="rtl">
        {error && <span role="alert" className="ml-3 self-center text-xs text-destructive">{error}</span>}
        <Button type="button" variant="outline" size="sm" onClick={handleLogout} disabled={busy}>
          {busy ? 'جارٍ...' : 'تسجيل الخروج'}
        </Button>
      </div>
      {children}
    </>
  );
}

function Router() {
  return (
    <Switch>
      <Route path="/" component={Home} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  useEffect(() => {
    document.documentElement.classList.add('dark');
    document.documentElement.setAttribute('dir', 'rtl');
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <DashboardAuthGate>
          <WouterRouter base={import.meta.env.BASE_URL?.replace(/\/$/, '') || ''}>
            <Router />
          </WouterRouter>
        </DashboardAuthGate>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
