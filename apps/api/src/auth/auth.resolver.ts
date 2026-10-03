import { Resolver, Mutation, Query, Args } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { AuthService } from './auth.service';
import { LoginResponse, UserResponse, LoginInput, RegisterInput } from './auth.types';
import { JwtAuthGuard } from './jwt-auth.guard';
import { RolesGuard } from './roles.guard';
import { Roles } from './roles.decorator';
import { CurrentUser } from './current-user.decorator';
import { Public } from './public.decorator';

@Resolver()
export class AuthResolver {
  constructor(private authService: AuthService) {}

  @Public()
  @Mutation(() => LoginResponse)
  async login(@Args('input') input: LoginInput) {
    return this.authService.login(input.email, input.password);
  }

  @Roles('ADMIN')
  @Mutation(() => UserResponse)
  async register(
    @Args('input') input: RegisterInput,
    @CurrentUser() user: any,
  ) {
    return this.authService.register(input.email, input.password, input.role, user.role);
  }

  @Query(() => UserResponse)
  async me(@CurrentUser() user: any) {
    return this.authService.getProfile(user.sub);
  }
}
