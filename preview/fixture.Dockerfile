FROM oven/bun:1.3.14
USER bun
EXPOSE 3000
CMD ["bun", "-e", "Bun.serve({hostname:'0.0.0.0',port:Number(process.env.PORT),fetch(){return new Response(process.env.PREVIEW_CONTENT,{headers:{'content-type':'text/plain'}})}})"]
