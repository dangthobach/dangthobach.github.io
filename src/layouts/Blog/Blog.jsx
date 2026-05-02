import './Blog.css'


const Blog = () => {
    return (
        <>
            <section id="blog">
                <p className='section__text__p1'>Share knowledge</p>
                <h1 className='title'>Knowledge Base</h1>
                <div className="blog-container">
                    <wired-card elevation="5" style={{ padding: '20px', textAlign: 'center', maxWidth: '600px', margin: '0 auto', display: 'block' }}>
                        <p style={{ marginBottom: '20px' }}>
                            I've compiled my notes and insights into a "Digital Garden" using Obsidian. 
                            Explore topics ranging from development to personal growth.
                        </p>
                        <a href="/knowledge" style={{ textDecoration: 'none' }}>
                            <wired-button elevation="3">
                                Visit Knowledge Base
                            </wired-button>
                        </a>
                    </wired-card>
                </div>
            </section>
        </>
    )
}

export default Blog