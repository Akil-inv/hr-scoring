import { Global, Module } from '@nestjs/common';
import { DocumentPasswordController } from './document-password.controller';
import { DocumentPasswordService } from './document-password.service';

/** Document passwords, and the protection of every file people download. */
@Global()
@Module({
  providers: [DocumentPasswordService],
  controllers: [DocumentPasswordController],
  exports: [DocumentPasswordService],
})
export class DocumentsModule {}
