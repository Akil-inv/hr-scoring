import { Resolver, Query } from '@nestjs/graphql';
import { AuthService } from './auth.service';
import { UserResponse } from './auth.types';
import { CurrentUser } from './current-user.decorator';

/**
 * Signing in, passwords, invites and two-factor are REST routes under
 * /api/auth (auth-kit; see auth-kit.ts). GraphQL keeps only "who am I".
 */
@Resolver()
export class AuthResolver {
  constructor(private authService: AuthService) {}

  @Query(() => UserResponse)
  async me(@CurrentUser() user: any) {
    return this.authService.getProfile(user.sub);
  }
}
