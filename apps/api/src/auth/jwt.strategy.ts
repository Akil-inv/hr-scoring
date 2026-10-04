import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { AUTH_SERVICE } from '@akil-inv/auth-kit/nest';
import type { AuthService as AuthKit } from '@akil-inv/auth-kit/server';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: ConfigService, @Inject(AUTH_SERVICE) private authKit: AuthKit) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('JWT_SECRET', 'dev-secret-change-in-production'),
    });
  }

  async validate(payload: any) {
    // auth-kit's own short-lived tokens (the two-factor step) are not sign-ins.
    if (payload.purpose) throw new UnauthorizedException();
    // Signed out since this token was issued (password or email changed, admin action, user deleted).
    if (!(await this.authKit.isCurrent(payload.sub, payload.tv))) throw new UnauthorizedException('Sign in again.');
    return { sub: payload.sub, email: payload.email, role: payload.role };
  }
}
