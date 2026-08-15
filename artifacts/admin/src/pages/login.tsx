import React, { useState } from 'react';
import { useLocation } from 'wouter';
import { useAdmin } from '@/contexts/AdminContext';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Lock } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';

export default function Login() {
  const [inputSecret, setInputSecret] = useState('');
  const { setSecret, apiFetch } = useAdmin();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      await apiFetch('/admin/overview', {
        headers: { 'X-Admin-Secret': inputSecret }
      });
      setSecret(inputSecret);
      setLocation('/');
    } catch (err) {
      toast({
        title: 'Access Denied',
        description: 'Invalid admin secret.',
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-sm flex flex-col items-center gap-8">
        <div className="flex items-center gap-2 text-primary font-mono font-bold tracking-widest text-2xl">
          <div className="w-4 h-4 bg-primary rounded-sm brand-glow"></div>
          PUMPI<span className="text-muted-foreground font-sans text-sm">/OPS</span>
        </div>
        
        <Card className="w-full border-border bg-card">
          <CardHeader className="text-center pb-2">
            <Lock className="w-8 h-8 mx-auto mb-2 text-muted-foreground" />
            <h2 className="text-lg font-medium">Authentication Required</h2>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="flex flex-col gap-4">
              <Input
                type="password"
                placeholder="Admin Secret"
                value={inputSecret}
                onChange={(e) => setInputSecret(e.target.value)}
                className="font-mono text-center"
                data-testid="input-secret"
                autoFocus
              />
              <Button type="submit" disabled={loading || !inputSecret} className="w-full font-bold" data-testid="button-login">
                {loading ? 'Verifying...' : 'Access Console'}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
