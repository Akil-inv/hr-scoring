import { Global, Module } from '@nestjs/common';
import { SettingsResolver } from './settings.resolver';
import { SettingsService } from './settings.service';

/** Platform switches (file passwords, two-factor). Global: sign-in and downloads read them. */
@Global()
@Module({
  providers: [SettingsService, SettingsResolver],
  exports: [SettingsService],
})
export class SettingsModule {}
