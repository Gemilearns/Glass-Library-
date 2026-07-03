// prisma/seed.js — minimal seed so /api/universities etc. are populated
import prisma from "../src/lib/prisma.js";

const universities = [
  {
    name: "University of Nairobi",
    faculties: [
      {
        name: "Faculty of Science and Technology",
        departments: [
          {
            name: "Computing and Informatics",
            units: [
              { code: "CCS 101", title: "Introduction to Programming" },
              { code: "CCS 202", title: "Data Structures and Algorithms" },
              { code: "CCS 305", title: "Database Systems" },
              { code: "CCS 401", title: "Operating Systems" },
            ],
          },
          {
            name: "Mathematics",
            units: [
              { code: "MAT 101", title: "Calculus I" },
              { code: "MAT 201", title: "Linear Algebra" },
            ],
          },
        ],
      },
      {
        name: "Faculty of Engineering",
        departments: [
          {
            name: "Electrical and Information Engineering",
            units: [
              { code: "EEE 201", title: "Circuit Theory" },
              { code: "EEE 305", title: "Digital Logic Design" },
            ],
          },
        ],
      },
    ],
  },
  {
    name: "Kenyatta University",
    faculties: [
      {
        name: "School of Pure and Applied Sciences",
        departments: [
          {
            name: "Computer Science",
            units: [
              { code: "SCT 101", title: "Discrete Mathematics" },
              { code: "SCT 201", title: "Object-Oriented Programming" },
              { code: "SCT 311", title: "Computer Networks" },
            ],
          },
        ],
      },
    ],
  },
  {
    name: "Strathmore University",
    faculties: [
      {
        name: "Faculty of Information Technology",
        departments: [
          {
            name: "Computing",
            units: [
              { code: "BIT 1101", title: "Fundamentals of Computing" },
              { code: "BIT 2204", title: "Web Development" },
            ],
          },
        ],
      },
    ],
  },
];

async function main() {
  console.log("[seed] starting…");
  for (const uni of universities) {
    const u = await prisma.university.upsert({
      where: { name: uni.name },
      update: {},
      create: { name: uni.name, country: "Kenya" },
    });

    for (const fac of uni.faculties) {
      const f = await prisma.faculty.upsert({
        where: { id: `seed-${u.id}-${fac.name}` },
        update: {},
        create: { id: `seed-${u.id}-${fac.name}`, universityId: u.id, name: fac.name },
      }).catch(async () =>
        prisma.faculty.create({
          data: { universityId: u.id, name: fac.name },
        })
      );

      for (const dept of fac.departments) {
        const d = await prisma.department.upsert({
          where: { id: `seed-${f.id}-${dept.name}` },
          update: {},
          create: { facultyId: f.id, name: dept.name },
        }).catch(async () =>
          prisma.department.create({
            data: { facultyId: f.id, name: dept.name },
          })
        );

        for (const unit of dept.units) {
          await prisma.unit.upsert({
            where: { departmentId_code: { departmentId: d.id, code: unit.code } },
            update: { title: unit.title },
            create: { departmentId: d.id, code: unit.code, title: unit.title },
          });
        }
      }
    }
    console.log(`[seed] ${uni.name} ✓`);
  }
  console.log("[seed] done.");
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error("[seed] failed:", err);
    await prisma.$disconnect();
    process.exit(1);
  });