import { SetMetadata } from "@nestjs/common";

export const IS_PUBLIC = "isPublic";

/** Marca um endpoint como aberto (health e métricas). Com um `AuthGuard` real, ele o deixaria passar. */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC, true);
