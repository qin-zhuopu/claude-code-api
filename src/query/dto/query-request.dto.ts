import { IsOptional, IsString, IsBoolean, IsNotEmpty } from 'class-validator';

export class QueryOptionsDto {
  @IsOptional()
  @IsString()
  cwd?: string;

  @IsOptional()
  @IsString()
  model?: string;

  @IsOptional()
  @IsBoolean()
  includePartialMessages?: boolean;
}

export class QueryRequestDto {
  @IsString()
  @IsNotEmpty()
  prompt: string;

  @IsOptional()
  options?: QueryOptionsDto;
}
