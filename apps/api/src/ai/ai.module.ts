import { Module } from "@nestjs/common";
import { AiService } from "./ai.service";
import { AiController } from "./ai.controller";
import { ToolModule } from "src/tool/tool.module";

@Module({
  controllers: [AiController],
  providers: [AiService],
  imports: [ToolModule],
})
export class AiModule {}
