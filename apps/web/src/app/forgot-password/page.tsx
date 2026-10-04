'use client';
import { ForgotPasswordForm } from '@akil-inv/auth-kit/react';
import { AuthFrame } from '@/lib/auth-kit';

export default function ForgotPasswordPage() {
  return <AuthFrame><ForgotPasswordForm signInHref="/login" /></AuthFrame>;
}
