#![allow(non_snake_case)]
use std::{env,mem};
#[repr(C)] struct Point{x:i32,y:i32}
#[repr(C)] #[derive(Copy,Clone)] struct MouseInput{dx:i32,dy:i32,mouse_data:u32,flags:u32,time:u32,extra:usize}
#[repr(C)] #[derive(Copy,Clone)] struct KeyInput{vk:u16,scan:u16,flags:u32,time:u32,extra:usize}
#[repr(C)] union InputData{mouse:MouseInput,key:KeyInput}
#[repr(C)] struct Input{kind:u32,data:InputData}
#[cfg(windows)]
#[link(name="user32")]
extern "system" {
    fn GetPhysicalCursorPos(p:*mut Point)->i32;
    fn GetCursorPos(p:*mut Point)->i32;
    fn SetThreadDpiAwarenessContext(c:*mut std::ffi::c_void)->*mut std::ffi::c_void;
    fn GetSystemMetrics(n:i32)->i32;
    fn SendInput(n:u32,p:*const Input,size:i32)->u32;
    fn GetLastError()->u32;
}
#[cfg(windows)] fn points()->(Point,Point) { let mut physical=Point{x:0,y:0}; let mut logical=Point{x:0,y:0}; unsafe{if GetPhysicalCursorPos(&mut physical)==0{panic!("GetPhysicalCursorPos failed")};if GetCursorPos(&mut logical)==0{panic!("GetCursorPos failed")}} (physical,logical) }
#[cfg(windows)] fn abs_point(x:i32,y:i32)->(i32,i32){ unsafe { let vx=GetSystemMetrics(76);let vy=GetSystemMetrics(77);let vw=GetSystemMetrics(78);let vh=GetSystemMetrics(79); if vw<=1||vh<=1{ return (0,0) }; let wx=(vw-1) as i64; let wy=(vh-1) as i64; let ax=((((x-vx) as i64*65535)+(wx/2))/wx).clamp(0,65535) as i32; let ay=((((y-vy) as i64*65535)+(wy/2))/wy).clamp(0,65535) as i32; (ax,ay) } }
#[cfg(windows)] fn absolute_mouse_flags()->u32{ unsafe { let vx=GetSystemMetrics(76);let vy=GetSystemMetrics(77);let vw=GetSystemMetrics(78);let vh=GetSystemMetrics(79);let sw=GetSystemMetrics(0);let sh=GetSystemMetrics(1);0x0001|0x8000|if vx!=0||vy!=0||vw!=sw||vh!=sh{0x4000}else{0} } }
#[cfg(windows)] fn move_mouse(x:i32,y:i32)->Result<(),String>{ unsafe {
    let (ax,ay)=abs_point(x,y);
    let mv=Input{kind:0,data:InputData{mouse:MouseInput{dx:ax,dy:ay,mouse_data:0,flags:absolute_mouse_flags(),time:0,extra:0}}};
    let mut last = None;
    // SendInput is synchronous with respect to queue insertion, but the
    // desktop cursor can be observed before the injected absolute move has
    // become visible to GetCursorPos/GetPhysicalCursorPos. Re-issue the same
    // deterministic native event only while the requested postcondition is
    // false; yield rather than sleeping for an arbitrary interval.
    for _ in 0..16 {
        if SendInput(1,&mv,mem::size_of::<Input>() as i32)!=1{return Err(format!("SendInput absolute mouse-move failed (GetLastError={})",GetLastError()))};
        let (physical,logical)=points();
        if physical.x==x&&physical.y==y{return Ok(())}
        last = Some((physical,logical));
        std::thread::yield_now();
    }
    let (physical,logical)=last.unwrap_or_else(||points());
    Err(format!("cursor mismatch physical {}:{} logical {}:{} expected {}:{}",physical.x,physical.y,logical.x,logical.y,x,y))
} }
#[cfg(windows)] fn click_mouse(x:i32,y:i32,flags:u32)->Result<(),String>{ unsafe {
    if flags==0{return Err("invalid-button".into())};
    move_mouse(x,y)?;
    let down=Input{kind:0,data:InputData{mouse:MouseInput{dx:0,dy:0,mouse_data:0,flags,time:0,extra:0}}};
    let up_flags=if flags==0x0008{0x0010}else{0x0004};
    let up=Input{kind:0,data:InputData{mouse:MouseInput{dx:0,dy:0,mouse_data:0,flags:up_flags,time:0,extra:0}}};
    let inputs=[down,up];
    if SendInput(2,inputs.as_ptr(),mem::size_of::<Input>() as i32)!=2{return Err("SendInput mouse-click failed".into())}; Ok(())
} }
#[cfg(windows)] fn send_wheel(delta:i32)->Result<(),String>{ unsafe{let i=Input{kind:0,data:InputData{mouse:MouseInput{dx:0,dy:0,mouse_data:delta as u32,flags:0x0800,time:0,extra:0}}};if SendInput(1,&i,mem::size_of::<Input>() as i32)!=1{return Err("SendInput wheel failed".into())}}Ok(())}
#[cfg(windows)] fn send_key(scan:u16)->Result<(),String>{ unsafe{let down=Input{kind:1,data:InputData{key:KeyInput{vk:0,scan,flags:0x0008,time:0,extra:0}}};let up=Input{kind:1,data:InputData{key:KeyInput{vk:0,scan,flags:0x0008|0x0002,time:0,extra:0}}};let sent_down=SendInput(1,&down,mem::size_of::<Input>() as i32);eprintln!("NATIVE_KEY_DOWN sent={}",sent_down);if sent_down!=1{return Err("SendInput key-down failed".into())};let sent_up=SendInput(1,&up,mem::size_of::<Input>() as i32);eprintln!("NATIVE_KEY_UP sent={}",sent_up);if sent_up!=1{return Err("SendInput key-up failed".into())}}Ok(())}
#[cfg(windows)] fn main(){unsafe{SetThreadDpiAwarenessContext((-4isize) as *mut std::ffi::c_void);}let a:Vec<String>=env::args().collect();if a.len()<2{eprintln!("usage");std::process::exit(2)}let r=match a[1].as_str(){"move"=>move_mouse(a[2].parse().unwrap(),a[3].parse().unwrap()),"click"=>{let x=a[2].parse().unwrap();let y=a[3].parse().unwrap();let f=if a.get(4).map(String::as_str)==Some("right"){0x0008}else{0x0002};click_mouse(x,y,f)},"key"=>send_key(a[2].parse().unwrap()),"wheel"=>send_wheel(a[2].parse().unwrap()),_=>Err("bad command".into())};if let Err(e)=r{eprintln!("{e}");std::process::exit(1)}}
#[cfg(not(windows))] fn main(){}
