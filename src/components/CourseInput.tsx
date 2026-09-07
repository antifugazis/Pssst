interface CourseInputProps {
  value: string;
  onChange: (value: string) => void;
}

const recentCourses = ['Architecture des ordinateurs', 'Analyse numérique', 'Systèmes d’exploitation'];

export function CourseInput({ value, onChange }: CourseInputProps) {
  return <div className="field course-field">
    <div className="field-label-row"><label className="field-label" htmlFor="course">Cours</label><span className="field-hint">Pour retrouver l’enregistrement</span></div>
    <div className="course-input-wrap"><span aria-hidden="true">⌘</span><input autoComplete="off" id="course" list="recent-courses" onChange={(event) => onChange(event.target.value)} placeholder="Ex. Architecture des ordinateurs" value={value}/></div>
    <datalist id="recent-courses">{recentCourses.map((course) => <option key={course} value={course}/>)}</datalist>
    {!value && <div className="recent-courses"><span>Récents</span>{recentCourses.slice(0, 2).map((course) => <button key={course} onClick={() => onChange(course)} type="button">{course}</button>)}</div>}
  </div>;
}
