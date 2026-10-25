const ownerId = '64b000000000000000000001';
const text = `LPC SYNTHETIC RESUME — FOR DEVELOPMENT ONLY
Dana Young

Summary
Paralegal supporting discovery and trial preparation.

Experience
Paralegal | Example Legal
2021–2024
Prepared discovery indexes and trial binders.

Legal assistant | Sample Counsel
2023–2025
Organized client records.

Education
Example College
Bachelor of Arts in Legal Studies

Skills / Tools
Legal research, Trial preparation, Clio

Practice areas
Litigation

Languages
Spanish
English (Fluent)
`;
function pdf(source = text) {
  const escape = value => value.replace(/[^\x20-\x7E]/g,'-').replace(/([\\()])/g,'\\$1');
  const commands = 'BT /F1 12 Tf 50 760 Td 16 TL\n' + source.split('\n').map(line=>`(${escape(line)}) Tj T*`).join('\n') + '\nET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${Buffer.byteLength(commands)} >>\nstream\n${commands}\nendstream`];
  let data='%PDF-1.4\n'; const offsets=[0];
  objects.forEach((object,index)=>{offsets.push(Buffer.byteLength(data));data+=`${index+1} 0 obj\n${object}\nendobj\n`;});
  const offset=Buffer.byteLength(data); data+=`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(v=>String(v).padStart(10,'0')+' 00000 n ').join('\n')}\ntrailer << /Size 6 /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF`; return Buffer.from(data);
}
function user(empty=false) { return { _id:ownerId,firstName:'Dana',lastName:'Young',email:'synthetic@example.invalid',role:'paralegal',status:'approved',state:'NY',location:'NY',profilePhotoRevision:'a'.repeat(64),profileImage:'/assets/avatar-placeholder.svg',profilePhotoStatus:'approved',bio:empty?'':'Existing About: litigation support.',about:'',specialties:[],jurisdictions:[],skills:empty?[]:['Discovery'],practiceAreas:empty?[]:['Litigation'],stateExperience:[],yearsExperience:7,experience:[],education:[],languages:[],resumeURL:`paralegal-resumes/${ownerId}/scan-required-synthetic.pdf`,notificationPrefs:{},preferences:{theme:'light',fontSize:'md'},onboarding:{paralegalTourCompleted:true,paralegalProfileTourCompleted:true} }; }
module.exports = { ownerId,text,pdf,user };
