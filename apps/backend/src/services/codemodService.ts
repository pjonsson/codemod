import { isNeitherNullNorUndefined } from "@codemod-com/utilities";
import { Codemod, CodemodVersion, Prisma, PrismaClient } from "@prisma/client";
import Fuse from "fuse.js";

const parseAndFilterQueryParams = (query: string | string[] | undefined) => {
	const result = [];

	if (!Array.isArray(query)) {
		if (isNeitherNullNorUndefined(query)) {
			result.push(query);
		}
	} else {
		result.push(...query.filter(isNeitherNullNorUndefined));
	}

	return result;
};

export type ShortCodemodInfo = Pick<Codemod, "name" | "author"> &
	Pick<CodemodVersion, "engine">;

export class CodemodNotFoundError extends Error {}

export class CodemodService {
	public constructor(protected prisma: PrismaClient) {}

	public async getCodemods(
		search: string | undefined,
		category: string | string[] | undefined,
		author: string | string[] | undefined,
		framework: string | string[] | undefined,
		verified: boolean | undefined,
		page: number,
		size: number,
	): Promise<{
		total: number;
		data: Codemod[];
		page: number;
		size: number;
	}> {
		const categories = parseAndFilterQueryParams(category);
		const authors = parseAndFilterQueryParams(author);
		const frameworks = parseAndFilterQueryParams(framework);

		const searchAndFilterClauses: Prisma.CodemodWhereInput["AND"] = [];
		const whereClause: Prisma.CodemodWhereInput = {
			AND: searchAndFilterClauses,
		};

		if (search) {
			searchAndFilterClauses.push({
				OR: [
					{
						name: {
							contains: search,
							mode: "insensitive" as Prisma.QueryMode,
						},
					},
					{
						shortDescription: {
							contains: search,
							mode: "insensitive" as Prisma.QueryMode,
						},
					},
					{ tags: { has: search } },
				],
			});
		}

		if (categories.length) {
			searchAndFilterClauses.push({ useCaseCategory: { in: categories } });
		}

		if (authors.length) {
			searchAndFilterClauses.push({ author: { in: authors } });
		}

		if (frameworks.length) {
			const frameworkAliases: string[] = [];

			const frameworkTags = await this.prisma.tag.findMany({
				where: {
					classification: "framework",
					aliases: { hasSome: frameworks },
				},
			});

			frameworkAliases.push(
				...frameworkTags.reduce((acc: string[], curr) => {
					acc.push(...curr.aliases);
					return acc;
				}, []),
			);

			searchAndFilterClauses.push({ tags: { hasSome: frameworkAliases } });
		}

		if (isNeitherNullNorUndefined(verified)) {
			searchAndFilterClauses.push({ verified });
		}

		const [codemods, total] = await Promise.all([
			this.prisma.codemod.findMany({
				where: whereClause,
				orderBy: {
					updatedAt: "desc",
				},
				skip: (page - 1) * size,
				take: size,
				include: {
					versions: {
						orderBy: {
							createdAt: "desc",
						},
						take: 1,
					},
				},
			}),
			this.prisma.codemod.count({ where: whereClause }),
		]);

		return { total, data: codemods, page, size };
	}

	public async getCodemodsFilters(): Promise<{
		useCaseFilters: {
			name: string | null;
			count: number;
		}[];
		ownerFilters: {
			name: string;
			count: number;
		}[];
		frameworkFilters: {
			name: string;
			count: number;
		}[];
	}> {
		const [frameworks, groupedUseCases, groupedOwners] = await Promise.all([
			this.prisma.tag.findMany({
				where: {
					classification: "framework",
				},
			}),
			this.prisma.codemod.groupBy({
				by: ["useCaseCategory"],
				_count: {
					_all: true,
				},
				where: {
					useCaseCategory: {
						not: null,
					},
				},
			}),
			this.prisma.codemod.groupBy({
				by: ["author"],
				_count: {
					_all: true,
				},
			}),
		]);

		const useCaseFilters = groupedUseCases.map(
			({ useCaseCategory, _count }) => ({
				name: useCaseCategory,
				count: _count._all,
			}),
		);

		const ownerFilters = groupedOwners.map(({ author, _count }) => ({
			name: author,
			count: _count._all,
		}));

		const frameworkFilters = await Promise.all(
			frameworks.map(async (framework) => {
				const count = await this.prisma.codemod.count({
					where: {
						tags: {
							hasSome: framework.aliases,
						},
					},
				});
				return {
					name: framework.displayName,
					count,
				};
			}),
		);

		return { useCaseFilters, ownerFilters, frameworkFilters };
	}

	public async getCodemodBySlug(slug: string): Promise<Codemod> {
		const codemod = await this.prisma.codemod.findFirst({
			where: {
				slug,
			},
			include: {
				versions: true,
			},
		});

		if (!codemod) {
			throw new CodemodNotFoundError();
		}

		return codemod;
	}

	public async getCodemodDownloadLink(name: string): Promise<{ link: string }> {
		const codemod = await this.prisma.codemod.findFirst({
			where: {
				name,
			},
			include: {
				versions: {
					orderBy: {
						createdAt: "desc",
					},
					take: 1,
				},
			},
		});

		const downloadLink = codemod?.versions[0]?.bucketLink;

		if (!downloadLink) {
			throw new CodemodNotFoundError();
		}

		return { link: downloadLink };
	}

	public async getCodemodsList(
		userId: string | null,
		search: string | undefined,
	): Promise<ShortCodemodInfo[]> {
		let codemodData: ShortCodemodInfo[];

		if (isNeitherNullNorUndefined(userId)) {
			// TODO: custom logic based on user auth
			const dbCodemods = await this.prisma.codemod.findMany();

			const codemods = await Promise.all(
				dbCodemods.map(async (codemod) => {
					const latestVersion = await this.prisma.codemodVersion.findFirst({
						where: {
							codemodId: codemod.id,
						},
						orderBy: {
							createdAt: "desc",
						},
					});

					if (!latestVersion) {
						return null;
					}

					return {
						name: codemod.name,
						engine: latestVersion?.engine,
						author: codemod.author,
						tags: latestVersion.tags,
						verified: codemod.verified,
						arguments: codemod.arguments,
					};
				}),
			);

			codemodData = codemods.filter(Boolean);
		} else {
			const dbCodemods = await this.prisma.codemod.findMany();

			const codemods = await Promise.all(
				dbCodemods.map(async (codemod) => {
					const latestVersion = await this.prisma.codemodVersion.findFirst({
						where: {
							codemodId: codemod.id,
						},
						orderBy: {
							createdAt: "desc",
						},
					});

					if (!latestVersion) {
						return null;
					}

					return {
						name: codemod.name,
						engine: latestVersion?.engine,
						author: codemod.author,
						tags: latestVersion.tags,
						verified: codemod.verified,
						arguments: codemod.arguments,
					};
				}),
			);

			codemodData = codemods.filter(Boolean);
		}

		if (search) {
			const fuse = new Fuse(codemodData, {
				keys: ["name", "tags"],
				isCaseSensitive: false,
				threshold: 0.35,
			});

			codemodData = fuse.search(search).map((res) => res.item);
		}

		return codemodData;
	}
}